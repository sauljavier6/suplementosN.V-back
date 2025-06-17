const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

// 🔹 Nueva Ruta: Obtener detalles de un producto
app.get('/productos/:id', async (req, res) => {
  const { id } = req.params;

  const getInventoryByVariantId = async (variantId) => {
    try {
      const response = await fetch(
        `${process.env.LOYVERSE_API}/inventory?variant_ids=${variantId}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}`,
            Accept: 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      const totalStock = data.inventory_levels.reduce(
        (acc, level) => acc + (level.in_stock || 0),
        0
      );

      return totalStock;
    } catch (error) {
      console.error('Error al obtener inventario:', error.message);
      return null;
    }
  };

  try {
    const response = await axios.get(`${process.env.LOYVERSE_API}/items/${id}`, {
      headers: {
        Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}`,
      },
    });

    const item = response.data;

    const variantsWithInventory = await Promise.all(
      item.variants.map(async (variant) => {
        const totalStock = await getInventoryByVariantId(variant.variant_id);
        return {
          ...variant,
          total_stock: totalStock,
        };
      })
    );

    res.json({
      ...item,
      variants: variantsWithInventory,
    });

  } catch (error) {
    console.error(`Error al obtener producto con ID ${id}:`, error.message);
    res.status(500).json({ error: 'No se pudo obtener el producto' });
  }
});


// Ruta: Obtener productos
app.get('/productos', async (req, res) => {
  try {
    const response = await axios.get(`${process.env.LOYVERSE_API}/items?limit=12`, {
      headers: {
        Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}`,
      },
    });

    const todosLosProductos = response.data.items;

    // Obtener el stock para cada producto filtrado (en paralelo)
    const productosConStock = await Promise.all(
      todosLosProductos.map(async (producto) => {
        // Obtener el stock de todas las variantes del producto
        const variantsWithStock = await Promise.all(
          producto.variants.map(async (variant) => {
            const stock = await getStockByVariantId(variant.variant_id);
            return {
              ...variant,
              total_stock: stock, // stock individual por variante
            };
          })
        );

        // Sumar todos los stocks para obtener el total del producto
        const totalStock = variantsWithStock.reduce((acc, variant) => acc + (variant.total_stock || 0), 0);

        // Retornar el producto con sus variantes actualizadas y total_stock
        return {
          ...producto,
          variants: variantsWithStock,
          total_stock: totalStock, // suma de todos los stocks
        };
      })
    );

    
    res.json(productosConStock);
  } catch (error) {
    console.error('Error al obtener productos:', error.message);
    res.status(500).json({ error: 'No se pudieron obtener los productos' });
  }
});

  const getStockByVariantId = async (variantId) => {
  try {
    const response = await fetch(
      `${process.env.LOYVERSE_API}/inventory?variant_ids=${variantId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // Sumamos todos los in_stock
    const totalStock = data.inventory_levels.reduce(
      (acc, level) => acc + (level.in_stock || 0),
      0
    );

    return totalStock;
  } catch (error) {
    console.error('Error al obtener inventario:', error.message);
    return 0; // Retornamos 0 si falla
  }
};


// Ruta: Obtener productos filtrados por categoría
app.get('/catalogo/:categoria', async (req, res) => {
  const { categoria } = req.params;
  const page = parseInt(req.query.page) || 1; // página actual, default 1
  const limit = parseInt(req.query.limit) || 10; // productos por página, default 10

  try {
    const response = await axios.get(`${process.env.LOYVERSE_API}/items`, {
      headers: {
        Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}`,
      },
    });

    const todosLosProductos = response.data.items;

    // Filtrar productos por category_id
    const productosFiltrados = todosLosProductos.filter(producto => producto.category_id === categoria);

    
    // Obtener el stock para cada producto filtrado (en paralelo)
    const productosConStock = await Promise.all(
      productosFiltrados.map(async (producto) => {
        // Obtener el stock de todas las variantes del producto
        const variantsWithStock = await Promise.all(
          producto.variants.map(async (variant) => {
            const stock = await getStockByVariantId(variant.variant_id);
            return {
              ...variant,
              total_stock: stock,
            };
          })
        );

        // Sumar todos los stocks para obtener el total del producto
        const totalStock = variantsWithStock.reduce((acc, variant) => acc + (variant.total_stock || 0), 0);

        // Retornar el producto con sus variantes actualizadas y total_stock
        return {
          ...producto,
          variants: variantsWithStock,
          total_stock: totalStock, // suma de todos los stocks
        };
      })
    );

    // Calcular paginación
    const total = productosConStock.length;
    const totalPages = Math.ceil(total / limit);
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;

    const productosPaginados = productosConStock.slice(startIndex, endIndex);

    // Respuesta con info de paginación
    res.json({
      page,
      limit,
      total,
      totalPages,
      items: productosPaginados,
    });
  } catch (error) {
    console.error('Error al obtener productos:', error.message);
    res.status(500).json({ error: 'No se pudieron obtener los productos' });
  }
});

// Ruta: Obtener productos filtrados por categoría
app.get('/busqueda/:busqueda', async (req, res) => {
  const { busqueda } = req.params;
  const page = parseInt(req.query.page) || 1; // página actual, default 1
  const limit = parseInt(req.query.limit) || 10; // productos por página, default 10

  try {
    const response = await axios.get(`${process.env.LOYVERSE_API}/items`, {
      headers: {
        Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}`,
      },
    });

    const todosLosProductos = response.data.items;

    // Filtrar productos por category_id
    const productosFiltrados = todosLosProductos.filter(producto =>producto.item_name.toLowerCase().includes(busqueda.toLowerCase()));

    
    // Obtener el stock para cada producto filtrado (en paralelo)
    const productosConStock = await Promise.all(
      productosFiltrados.map(async (producto) => {
        // Obtener el stock de todas las variantes del producto
        const variantsWithStock = await Promise.all(
          producto.variants.map(async (variant) => {
            const stock = await getStockByVariantId(variant.variant_id);
            return {
              ...variant,
              total_stock: stock,
            };
          })
        );

        // Sumar todos los stocks para obtener el total del producto
        const totalStock = variantsWithStock.reduce((acc, variant) => acc + (variant.total_stock || 0), 0);

        // Retornar el producto con sus variantes actualizadas y total_stock
        return {
          ...producto,
          variants: variantsWithStock,
          total_stock: totalStock, // suma de todos los stocks
        };
      })
    );
    
    // Calcular paginación
    const total = productosConStock.length;
    const totalPages = Math.ceil(total / limit);
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;

    const productosPaginados = productosConStock.slice(startIndex, endIndex);

    // Respuesta con info de paginación
    res.json({
      page,
      limit,
      total,
      totalPages,
      items: productosPaginados,
    });
  } catch (error) {
    console.error('Error al obtener productos:', error.message);
    res.status(500).json({ error: 'No se pudieron obtener los productos' });
  }
});

// POST /api/send-email
app.post('/email', async (req, res) => {
  const { email } = req.body;

  // Configura el transportador SMTP
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const mailOptions = {
    from: email,
    to: process.env.SMTP_USER,
    subject: '🎉 ¡Solicitud de suscripción a promociones!',
    html: `
      <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.5;">
        <h2 style="color: #0077cc;">Solicitud de suscripción a promociones</h2>
        <p>Hola,</p>
        <p>El siguiente usuario desea recibir promociones:</p>
        <p>
          <strong>Correo:</strong> <a href="mailto:${email}" style="color: #0077cc;">${email}</a>
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 0.9em; color: #666;">
          Este es un mensaje automático de suscripción.<br/>
          Saludos,<br/>
          <em>Tu Sitio Web</em>
        </p>
      </div>
    `,
  };


  const userMailOptions = {
    from: process.env.SMTP_USER,
    to: email,
    subject: '✅ ¡Gracias por suscribirte a nuestras promociones!',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2 style="color: #4CAF50;">¡Gracias por suscribirte!</h2>
        <p>Hola,</p>
        <p>Hemos recibido tu solicitud para recibir promociones. Pronto comenzarás a recibir nuestras mejores ofertas directamente en tu correo.</p>
        <br />
        <p>Si tú no realizaste esta solicitud, por favor ignora este mensaje.</p>
        <hr />
        <p style="font-size: 12px; color: #888;">Este es un mensaje automático. No respondas a este correo.</p>
      </div>
    `,
  };



  try {
    await transporter.sendMail(mailOptions);
    await transporter.sendMail(userMailOptions);
    res.status(200).json({ email, mgs: "success" });
  } catch (error) {
    console.error('Error al enviar correo:', error);
    res.status(500).json({ message: 'Error al enviar el correo' });
  }
});


// Escucha del servidor
app.listen(process.env.PORT, () => {
  console.log(`Servidor proxy escuchando en http://localhost:${process.env.PORT}`);
});
