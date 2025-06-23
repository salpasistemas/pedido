export default async function handler(req, res) {
  let xmlrpc;
  try {
    xmlrpc = require('xmlrpc');
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Could not load xmlrpc module',
      details: err.message
    });
  }

  const allowedOrigins = [
    'https://salpasistemas.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { location_id = 8, pricelist_id = 5 } = req.body || {};
    const { ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD } = process.env;
    const missing = ['ODOO_URL','ODOO_DB','ODOO_USERNAME','ODOO_PASSWORD'].filter(v => !process.env[v]);
    if (missing.length) {
      return res.status(500).json({
        success: false,
        error: `Missing environment variables: ${missing.join(', ')}`
      });
    }

    // Función helper para crear promesas XML-RPC
    const xmlrpcCall = (client, method, params) => {
      return new Promise((resolve, reject) => {
        client.methodCall(method, params, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    };

    // Autenticación
    const common = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/common` });
    const uid = await xmlrpcCall(common, 'authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}]);

    if (!uid) {
      return res.status(401).json({ success: false, error: 'Authentication failed' });
    }

    const models = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/object` });

    // Buscar quants con stock disponible
    const quantIds = await xmlrpcCall(models, 'execute_kw', [
      ODOO_DB, uid, ODOO_PASSWORD,
      'stock.quant', 'search',
      [[
        ['location_id', '=', parseInt(location_id)],
        ['quantity', '>', 0],
        ['product_id.active', '=', true]
      ]]
    ]);

    if (quantIds.length === 0) {
      return res.status(200).json({
        success: true,
        products: [],
        message: `No stock found in location ${location_id}`
      });
    }

    // Leer información de quants
    const quants = await xmlrpcCall(models, 'execute_kw', [
      ODOO_DB, uid, ODOO_PASSWORD,
      'stock.quant', 'read',
      [quantIds, ['product_id', 'quantity', 'reserved_quantity']]
    ]);

    // Calcular cantidades disponibles por producto
    const productQuantities = {};
    quants.forEach(quant => {
      const productId = quant.product_id[0];
      const availableQty = quant.quantity - (quant.reserved_quantity || 0);
      if (availableQty > 0) {
        productQuantities[productId] = (productQuantities[productId] || 0) + availableQty;
      }
    });

    const allProductIds = Object.keys(productQuantities).map(id => parseInt(id));
    if (allProductIds.length === 0) {
      return res.status(200).json({
        success: true,
        products: [],
        message: 'No products with available stock'
      });
    }

    // Filtrar productos por categoría
    const filteredProductIds = await xmlrpcCall(models, 'execute_kw', [
      ODOO_DB, uid, ODOO_PASSWORD,
      'product.product', 'search',
      [[
        ['id', 'in', allProductIds],
        ['categ_id', 'child_of', 88]
      ]]
    ]);

    if (filteredProductIds.length === 0) {
      return res.status(200).json({
        success: true,
        products: [],
        message: 'No products matching category filter'
      });
    }

    // Obtener información de productos - incluimos display_name explícitamente
    const products = await xmlrpcCall(models, 'execute_kw', [
      ODOO_DB, uid, ODOO_PASSWORD,
      'product.product', 'read',
      [filteredProductIds, ['display_name', 'default_code', 'list_price', 'name']]
    ]);

    // Obtener precios de la lista de precios
    const productPrices = {};
    const pricePromises = products.map(async product => {
      try {
        const price = await xmlrpcCall(models, 'execute_kw', [
          ODOO_DB, uid, ODOO_PASSWORD,
          'product.pricelist', 'get_product_price',
          [parseInt(pricelist_id), product.id, 1]
        ]);
        productPrices[product.id] = price || product.list_price || 0;
      } catch (err) {
        console.error(`Error getting price for product ${product.id}:`, err.message);
        productPrices[product.id] = product.list_price || 0;
      }
    });

    await Promise.all(pricePromises);

    // Preparar datos finales
    const finalProducts = products
      .map(product => ({
        product_id: product.id,
        name: product.name,
        display_name: product.display_name, // Incluir display_name
        default_code: product.default_code || '',
        qty_available: Math.floor(productQuantities[product.id] || 0), // Redondear a entero
        price: Math.round(productPrices[product.id] * 100) / 100 // Redondear a 2 decimales
      }))
      .filter(product => product.qty_available > 0) // Solo productos con stock
      .sort((a, b) => (a.display_name || a.name).localeCompare(b.display_name || b.name)); // Ordenar por display_name

    return res.status(200).json({
      success: true,
      products: finalProducts,
      total_products: finalProducts.length,
      location_id: parseInt(location_id),
      pricelist_id: parseInt(pricelist_id),
      generated_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
