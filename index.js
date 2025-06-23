import morgan from 'morgan';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import pLimit from 'p-limit';

// Cargar variables de entorno
dotenv.config();

const app = express();
app.use(morgan('dev'));
app.use(cors());
app.use(express.json());


const limitConcurrent = pLimit(5);

const getStockByVariantId = async (variantId) => {
  try {
    const response = await fetch(
      `${process.env.LOYVERSE_API}/inventory?variant_ids=${variantId}&limit=250`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      return 0;
    }

    const data = await response.json();
    const totalStock = data.inventory_levels.reduce(
      (acc, level) => acc + (level.in_stock || 0),
      0
    );

    return totalStock;
  } catch (error) {
    console.error('Error al obtener inventario:', error.message);
    return 0;
  }
};

const getStockByVariantIds = async (variantIds = []) => {
  const stockMap = {};
  const chunkSize = 250;

  // Divide en grupos de 50 variantes
  for (let i = 0; i < variantIds.length; i += chunkSize) {
    const chunk = variantIds.slice(i, i + chunkSize);
    let cursor = null;
    let attempts = 0;

    do {
      const url = `${process.env.LOYVERSE_API}/inventory?variant_ids=${chunk.join(',')}&limit=250${cursor ? `&cursor=${cursor}` : ''}`;

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}`,
            Accept: 'application/json',
          },
        });

        if (response.status === 429) {
          // Esperar antes de continuar si estamos siendo bloqueados
          console.warn('Demasiadas solicitudes, esperando 1 segundo...');
          await new Promise(res => setTimeout(res, 1000)); // 1 segundo de espera
          attempts++;
          if (attempts > 5) {
            console.warn('Demasiados intentos fallidos con código 429.');
            break;
          }
          continue; // intenta de nuevo
        }

        if (!response.ok) {
          console.warn(`Error al obtener inventario (status: ${response.status})`);
          break;
        }

        const data = await response.json();

        data.inventory_levels.forEach(level => {
          const id = level.variant_id;
          stockMap[id] = (stockMap[id] || 0) + (level.in_stock || 0);
        });

        cursor = data.cursor;
      } catch (error) {
        console.error('Error al obtener inventario:', error.message);
        break;
      }
    } while (cursor);
  }

  return stockMap;
};


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
  const limiteFinal = 12;
  let productosConStockAcumulados = [];
  let cursor = null;
  let seguirBuscando = true;

  try {
    while (seguirBuscando) {
      // Construye la URL con cursor si existe
      const url = `${process.env.LOYVERSE_API}/items?limit=60${cursor ? `&cursor=${cursor}` : ''}`;
      
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}`,
        },
      });

      const productos = response.data.items;
      cursor = response.data.cursor || null;

      // Obtener stock y filtrar productos con stock > 0
      const productosConStock = await Promise.all(
        productos.map(async (producto) => {
          const variantsWithStock = await Promise.all(
            producto.variants.map((variant) =>
              limitConcurrent(async () => {
                const stock = await getStockByVariantId(variant.variant_id);
                return { ...variant, total_stock: stock };
              })
            )
          );

          const totalStock = variantsWithStock.reduce(
            (acc, variant) => acc + (variant.total_stock || 0),
            0
          );

          return { ...producto, variants: variantsWithStock, total_stock: totalStock };
        })
      );

      // Filtrar productos con stock > 0
      const productosFiltrados = productosConStock.filter(p => p.total_stock > 0);

      // Acumular
      productosConStockAcumulados = productosConStockAcumulados.concat(productosFiltrados);

      // Revisar si ya juntamos suficientes o no hay más cursor
      if (productosConStockAcumulados.length >= limiteFinal || !cursor) {
        seguirBuscando = false;
      }
    }

    // Limitar a los primeros 12 que tengan stock
    const resultadoFinal = productosConStockAcumulados.slice(0, limiteFinal);

    res.json(resultadoFinal);

  } catch (error) {
    console.error('Error al obtener productos:', error.message);
    res.status(500).json({ error: 'No se pudieron obtener los productos' });
  }
});


let ultimaCategoria = null;
let ultimaTalla = null;
let productos = [];
let cursornuevo = null;
let idsVistos = new Set();
let productosConStockPositivo = [];

app.get('/catalogo/:categoria', async (req, res) => {
  const { categoria } = req.params;
  const talla = req.query.talla || null;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 32;
  const startIndex = (page - 1) * limit;
  const endIndex = startIndex + limit;

  try {
    const necesitaActualizar =
      categoria !== ultimaCategoria || talla !== ultimaTalla;

    if (necesitaActualizar) {
      // Reiniciar estado si cambió la categoría o la talla
      productos = [];
      cursornuevo = null;
      idsVistos = new Set();

      // Obtener todos los productos de esa categoría
      do {
        const url = `${process.env.LOYVERSE_API}/items?limit=250&show_deleted=false${cursornuevo ? `&cursor=${cursornuevo}` : ''}`;
        const response = await axios.get(url, {
          headers: { Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}` },
        });

        const nuevosProductos = response.data.items;
        const productosFiltrados = nuevosProductos.filter(p => {
          if (idsVistos.has(p.id)) return false;
          idsVistos.add(p.id);
          return p.category_id === categoria;
        });

        productos = [...productos, ...productosFiltrados];
        cursornuevo = response.data.cursor;
      } while (cursornuevo);

      // Aplicar filtro por talla si existe
      let productosFiltrados = [...productos];
      if (talla) {
        productosFiltrados = productosFiltrados.filter(producto =>
          producto.variants.some(
            variant =>
              typeof variant.option1_value === 'string' &&
              variant.option1_value.toLowerCase() === talla.toLowerCase()
          )
        );
      }

      // Obtener stock por variante en lote
      const productosConStock = await Promise.all(
        productosFiltrados.map(async (producto) => {
          const variantIds = producto.variants.map(v => v.variant_id);
          const stockMap = await getStockByVariantIds(variantIds);

          const variantsWithStock = producto.variants.map((variant) => {
            const stock = stockMap[variant.variant_id] || 0;
            return { ...variant, total_stock: stock };
          });

          const totalStock = variantsWithStock.reduce(
            (acc, v) => acc + (v.total_stock || 0), 0
          );

          return { ...producto, variants: variantsWithStock, total_stock: totalStock };
        })
      );

      productosConStockPositivo = productosConStock.filter(p => p.total_stock > 0);
      ultimaCategoria = categoria;
      ultimaTalla = talla;
    }

    const total = productosConStockPositivo.length;
    const totalPages = Math.ceil(total / limit);
    const productosPaginados = productosConStockPositivo.slice(startIndex, endIndex);

    return res.json({
      page,
      limit,
      total,
      totalPages,
      items: productosPaginados,
    });

  } catch (error) {
    console.error('Error al obtener productos:', error.message);
    return res.status(500).json({ error: 'No se pudieron obtener los productos' });
  }
});



// Ruta: Obtener productos filtrados por busqueda
app.get('/busqueda/:busqueda', async (req, res) => {
  const { busqueda } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 60;

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

    const productosConStockPositivo = productosConStock.filter(p => p.total_stock > 0);
    
    // Calcular paginación
    const total = productosConStockPositivo.length;
    const totalPages = Math.ceil(total / limit);
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    let cursorbusqueda = null

    if (totalPages > 1 && page < totalPages) {
      cursorbusqueda="jdbejfjbk"
    }
    else {
      cursorbusqueda=null 
    }

    const productosPaginados = productosConStockPositivo.slice(startIndex, endIndex);

    // Respuesta con info de paginación
    res.json({
      page,
      limit,
      total,
      totalPages,
      items: productosPaginados,
      cursor: cursorbusqueda || null,
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
