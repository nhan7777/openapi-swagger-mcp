// Deterministic builder for the frozen search benchmark corpus. Output JSON files under ./specs are the frozen
// artifact (hashed in ../manifest.json); this script only documents how they were produced. Synthetic data only.
// Usage: node bench/search/corpus/build-specs.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'specs');

const T = (t) => (typeof t === 'string' ? { type: t } : t);
const obj = (props, extra = {}) => ({ type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, T(v)])), ...extra });
const arr = (items) => ({ type: 'array', items: T(items) });
const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const desc = (t, d) => ({ ...T(t), description: d });
const json = (schema) => ({ content: { 'application/json': { schema } } });

/** op(method, path, operationId, summary, description, { tags, query, req, res, resStatus }) */
function op(method, p, operationId, summary, description, o = {}) {
  const params = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => ({ in: 'path', name: m[1], required: true, schema: { type: 'string' } }));
  for (const q of o.query ?? []) {
    const [name, d] = Array.isArray(q) ? q : [q, undefined];
    params.push({ in: 'query', name, required: false, schema: { type: 'string' }, ...(d ? { description: d } : {}) });
  }
  const node = {
    operationId,
    summary,
    ...(description ? { description } : {}),
    ...(o.tags ? { tags: o.tags } : {}),
    ...(params.length ? { parameters: params } : {}),
    ...(o.req ? { requestBody: { required: true, ...json(o.req) } } : {}),
    responses: { [o.resStatus ?? (method === 'post' ? '201' : '200')]: { description: 'ok', ...(o.res ? json(o.res) : {}) }, default: { description: 'error', ...json(ref('Error')) } },
  };
  return [p, method, node];
}

function doc(title, ops, schemas) {
  const paths = {};
  for (const [p, m, node] of ops) (paths[p] ??= {})[m] = node;
  return { openapi: '3.0.3', info: { title, version: '1.0.0' }, paths, components: { schemas: { Error: obj({ code: 'string', message: 'string' }), ...schemas } } };
}

// ---- shop: Vietnamese + English retail API ---------------------------------------------------
const shopSchemas = {
  Address: obj({ street: 'string', city: 'string', postalCode: desc('string', 'Mã bưu chính'), provinceCode: 'string' }),
  OrderLine: obj({ sku: 'string', unitPrice: desc('number', 'Đơn giá'), quantity: 'integer' }),
  Order: obj({
    orderId: 'string',
    status: desc('string', 'Trạng thái đơn hàng'),
    totalAmount: 'number',
    currency: 'string',
    customer: obj({ customerName: desc('string', 'Tên khách hàng'), phoneNumber: desc('string', 'Số điện thoại') }),
    lines: arr(ref('OrderLine')),
    shippingAddress: ref('Address'),
    trackingNumber: desc('string', 'Mã vận đơn'),
  }),
  OrderInput: obj({ customerId: 'string', lines: arr(obj({ sku: 'string', quantity: 'integer' })), shippingAddress: ref('Address'), couponCode: desc('string', 'Mã giảm giá') }),
  OrderPage: obj({ items: arr(ref('Order')), nextPage: 'string' }),
  Invoice: obj({
    invoiceNumber: desc('string', 'Số hóa đơn'),
    taxCode: desc('string', 'Mã số thuế'),
    issueDate: 'string',
    totalAmount: 'number',
    vatRate: desc('number', 'Thuế suất GTGT'),
    buyer: obj({ taxCode: 'string', companyName: desc('string', 'Tên công ty người mua') }),
  }),
  Customer: obj({ customerId: 'string', fullName: 'string', phoneNumber: 'string', loyaltyPoints: 'integer', membershipLevel: desc('string', 'Hạng thành viên') }),
  CustomerInput: obj({ fullName: 'string', phoneNumber: 'string', email: 'string', dateOfBirth: 'string' }),
  Product: obj({ sku: 'string', productName: 'string', unitPrice: 'number', stockQuantity: 'integer', barcode: 'string', eanCode: desc('string', 'EAN-13 barcode') }),
  Payment: obj({ paymentId: 'string', paymentStatus: desc('string', 'Trạng thái thanh toán'), transactionRef: 'string', qrCodeUrl: desc('string', 'QR code for bank transfer') }),
  Tokens: obj({ accessToken: 'string', refreshToken: 'string', expiresIn: desc('integer', 'Seconds until the access token expires') }),
};
const shop = doc('Shop', [
  op('get', '/orders', 'listOrders', 'List orders', 'Danh sách đơn hàng theo trạng thái', { tags: ['orders'], query: ['status', 'customerId', 'page', 'pageSize'], res: ref('OrderPage') }),
  op('post', '/orders', 'createOrder', 'Create order', 'Tạo đơn hàng mới', { tags: ['orders'], req: ref('OrderInput'), res: ref('Order') }),
  op('get', '/orders/{orderId}', 'getOrder', 'Get order detail', 'Chi tiết đơn hàng', { tags: ['orders'], res: ref('Order') }),
  op('patch', '/orders/{orderId}', 'updateOrder', 'Update order', 'Cập nhật đơn hàng', { tags: ['orders'], req: obj({ status: 'string', note: 'string' }), res: ref('Order') }),
  op('delete', '/orders/{orderId}', 'cancelOrder', 'Cancel order', 'Hủy đơn hàng', { tags: ['orders'], query: [['reason', 'Lý do hủy']] }),
  op('post', '/orders/{orderId}/refunds', 'createRefund', 'Refund order', 'Hoàn tiền đơn hàng', { tags: ['orders', 'payments'], req: obj({ amount: 'number', reasonCode: 'string' }), res: obj({ refundId: 'string', refundStatus: 'string' }) }),
  op('get', '/orders/{orderId}/shipments', 'listOrderShipments', 'Shipments of an order', 'Danh sách vận đơn của đơn hàng', { tags: ['shipping'], res: obj({ items: arr(obj({ shipmentId: 'string', carrierName: 'string', trackingNumber: 'string', estimatedDeliveryDate: 'string' })) }) }),
  op('get', '/orders/{orderId}/history', 'getOrderHistory', 'Order status history', 'Lịch sử trạng thái đơn hàng', { tags: ['orders'], res: obj({ items: arr(obj({ status: 'string', changedAt: 'string', changedBy: 'string' })) }) }),
  op('get', '/invoices', 'listInvoices', 'List invoices', 'Danh sách hóa đơn', { tags: ['invoices'], query: ['fromDate', 'toDate'], res: obj({ items: arr(ref('Invoice')) }) }),
  op('get', '/invoices/{invoiceId}', 'getInvoice', 'Get invoice', 'Chi tiết hóa đơn VAT', { tags: ['invoices'], res: ref('Invoice') }),
  op('post', '/invoices/{invoiceId}/send', 'sendInvoiceEmail', 'Send invoice by email', 'Gửi hóa đơn qua email', { tags: ['invoices'], req: obj({ emailAddress: 'string' }), resStatus: '202' }),
  op('get', '/invoices/{invoiceId}/pdf', 'downloadInvoicePdf', 'Download invoice PDF', 'Tải hóa đơn PDF', { tags: ['invoices'] }),
  op('get', '/customers', 'listCustomers', 'Search customers', 'Tìm kiếm khách hàng theo tên hoặc số điện thoại', { tags: ['customers'], query: ['q', 'phoneNumber'], res: obj({ items: arr(ref('Customer')) }) }),
  op('post', '/customers', 'createCustomer', 'Create customer', 'Tạo khách hàng', { tags: ['customers'], req: ref('CustomerInput'), res: ref('Customer') }),
  op('get', '/customers/{customerId}', 'getCustomer', 'Get customer', 'Thông tin khách hàng', { tags: ['customers'], res: ref('Customer') }),
  op('get', '/customers/{customerId}/addresses', 'listCustomerAddresses', 'Customer addresses', 'Sổ địa chỉ khách hàng', { tags: ['customers'], res: obj({ items: arr(ref('Address')) }) }),
  op('get', '/products', 'listProducts', 'List products', 'Danh sách sản phẩm', { tags: ['catalog'], query: ['category', 'minPrice', 'maxPrice'], res: obj({ items: arr(ref('Product')) }) }),
  op('get', '/products/{sku}', 'getProduct', 'Get product', 'Chi tiết sản phẩm', { tags: ['catalog'], res: ref('Product') }),
  op('put', '/products/{sku}/price', 'updateProductPrice', 'Update product price', 'Cập nhật giá sản phẩm', { tags: ['catalog'], req: obj({ unitPrice: 'number', effectiveFrom: 'string' }), res: ref('Product') }),
  op('get', '/inventory/warehouses/{warehouseId}/stock', 'getWarehouseStock', 'Warehouse stock levels', 'Tồn kho theo kho, theo SKU', { tags: ['inventory'], res: obj({ items: arr(obj({ sku: 'string', availableQuantity: 'integer', reservedQuantity: 'integer' })) }) }),
  op('post', '/inventory/transfers', 'createStockTransfer', 'Transfer stock between warehouses', 'Chuyển kho', { tags: ['inventory'], req: obj({ fromWarehouseId: 'string', toWarehouseId: 'string', items: arr(obj({ sku: 'string', quantity: 'integer' })) }), res: obj({ transferId: 'string' }) }),
  op('post', '/payments', 'createPayment', 'Create payment', 'Thanh toán đơn hàng', { tags: ['payments'], req: obj({ orderId: 'string', paymentMethod: 'string', cardToken: 'string' }), res: ref('Payment') }),
  op('get', '/payments/{paymentId}', 'getPayment', 'Get payment status', 'Trạng thái thanh toán', { tags: ['payments'], res: ref('Payment') }),
  op('post', '/payments/{paymentId}/capture', 'capturePayment', 'Capture payment', 'Ghi nhận thanh toán đã ủy quyền', { tags: ['payments'], req: obj({ captureAmount: 'number', merchantReference: desc('string', 'Merchant reference sent by the caller') }), resStatus: '204' }),
  op('post', '/auth/login', 'login', 'Log in', 'Đăng nhập', { tags: ['auth'], req: obj({ username: 'string', password: 'string' }), res: ref('Tokens'), resStatus: '200' }),
  op('post', '/auth/refresh', 'refreshToken', 'Refresh access token', 'Làm mới token', { tags: ['auth'], req: obj({ refreshToken: 'string' }), res: ref('Tokens'), resStatus: '200' }),
  op('post', '/auth/otp/send', 'sendOtpSMS', 'Send OTP via SMS', 'Gửi mã OTP qua tin nhắn', { tags: ['auth'], req: obj({ phoneNumber: 'string' }), resStatus: '202' }),
  op('post', '/auth/otp/verify', 'verifyOtp', 'Verify OTP code', 'Xác thực mã OTP', { tags: ['auth'], req: obj({ phoneNumber: 'string', otp: 'string' }), res: ref('Tokens'), resStatus: '200' }),
  op('get', '/users/me', 'getCurrentUser', 'Current user profile', 'Hồ sơ người dùng', { tags: ['auth'], res: obj({ userId: 'string', displayName: 'string', roles: arr('string') }) }),
  op('get', '/reports/sales', 'getSalesReport', 'Sales report', 'Báo cáo doanh thu', { tags: ['reports'], query: ['fromDate', 'toDate', 'groupBy'], res: obj({ rows: arr(obj({ period: 'string', revenue: 'number', orderCount: 'integer' })) }) }),
  op('get', '/reports/vat', 'getVatReport', 'VAT report', 'Báo cáo thuế GTGT', { tags: ['reports'], query: ['month'] }),
  op('post', '/webhooks', 'registerWebhook', 'Register webhook', 'Đăng ký webhook', { tags: ['integration'], req: obj({ callbackUrl: desc('string', 'HTTPS callback URL'), events: arr('string') }), res: obj({ webhookId: 'string' }) }),
  op('get', '/health', 'getHealth', 'Health check', 'HTTP health check endpoint', { tags: ['ops'] }),
  op('get', '/shipping/fees', 'calculateShippingFee', 'Calculate shipping fee', 'Tính phí vận chuyển', { tags: ['shipping'], query: ['provinceCode', 'weightGrams'], res: obj({ fee: 'number', carrierName: 'string' }) }),
  op('get', '/provinces', 'listProvinces', 'List provinces', 'Danh sách tỉnh thành', { tags: ['shipping'], res: obj({ items: arr(obj({ provinceCode: 'string', provinceName: 'string' })) }) }),
  op('post', '/promotions/validate', 'validateCoupon', 'Validate coupon', 'Kiểm tra mã giảm giá', { tags: ['promotions'], req: obj({ couponCode: 'string', orderTotal: 'number' }), res: obj({ discountAmount: 'number', valid: 'boolean' }), resStatus: '200' }),
  op('get', '/loyalty/{customerId}/points', 'getLoyaltyPoints', 'Loyalty points balance', 'Điểm tích lũy', { tags: ['customers'], res: obj({ loyaltyPoints: 'integer', expiringPoints: 'integer' }) }),
  op('post', '/files/upload', 'uploadAttachment', 'Upload attachment', 'Tải tệp đính kèm', { tags: ['files'], res: obj({ fileId: 'string' }) }),
  op('get', '/employees/{employeeId}', 'getEmployee', 'Get employee', 'Thông tin nhân viên', { tags: ['hr'], res: obj({ employeeId: 'string', fullName: 'string', department: 'string' }) }),
  op('get', '/stores', 'listStores', 'List stores', 'Danh sách cửa hàng', { tags: ['stores'], res: obj({ items: arr(obj({ storeCode: 'string', storeName: 'string', openingHours: 'string' })) }) }),
  op('get', '/api/v2/orders/{orderId}/receipt', 'getReceiptV2', 'Get receipt (v2)', 'Biên lai', { tags: ['orders'], res: obj({ receiptNumber: 'string', merchantReference: 'string', totalAmount: 'number' }) }),
], shopSchemas);

// ---- crm-a / crm-b: two services with overlapping endpoints --------------------------------
const crmCommon = [
  op('get', '/customers/{id}', 'getCustomer', 'Get customer', 'Customer record', { tags: ['customers'], res: obj({ id: 'string', name: 'string', segment: 'string' }) }),
  op('get', '/contacts', 'listContacts', 'List contacts', undefined, { tags: ['contacts'], query: ['customerId'], res: obj({ items: arr(obj({ contactId: 'string', email: 'string' })) }) }),
  op('post', '/leads', 'createLead', 'Create lead', undefined, { tags: ['leads'], req: obj({ name: 'string', source: 'string' }), res: obj({ leadId: 'string' }) }),
  op('get', '/deals/{dealId}', 'getDeal', 'Get deal', 'Deal detail', { tags: ['deals'], res: obj({ dealId: 'string', stage: 'string', amount: 'number' }) }),
];
const crmA = doc('CRM A', [
  ...crmCommon,
  op('post', '/deals/{dealId}/stage', 'moveDealStage', 'Move deal to stage', undefined, { tags: ['deals'], req: obj({ stage: 'string' }), resStatus: '204' }),
  op('get', '/activities', 'listActivities', 'List activities', 'Calls, meetings and emails', { tags: ['activities'], res: obj({ items: arr(obj({ activityId: 'string', kind: 'string' })) }) }),
], {});
const crmB = doc('CRM B', [
  ...crmCommon,
  op('get', '/tickets', 'listTickets', 'List support tickets', undefined, { tags: ['support'], res: obj({ items: arr(obj({ ticketId: 'string', priority: 'string' })) }) }),
  op('post', '/tickets', 'createTicket', 'Create ticket', 'Open a support ticket', { tags: ['support'], req: obj({ subject: 'string', priority: 'string' }), res: obj({ ticketId: 'string' }) }),
], {});

// ---- cjk: Chinese and Japanese summaries -------------------------------------------------
const cjk = doc('CJK', [
  op('get', '/orders/{id}', 'getOrderCn', '获取订单详情', undefined, { res: obj({ orderNo: desc('string', '订单编号'), amount: 'number' }) }),
  op('get', '/orders', 'listOrdersCn', '查询订单列表', undefined, { query: [['status', '订单状态']] }),
  op('post', '/orders', 'createOrderCn', '创建订单', undefined, { req: obj({ items: arr(obj({ skuId: 'string', count: 'integer' })) }) }),
  op('get', '/users/{id}', 'getUserCn', '获取用户信息', undefined, { res: obj({ nickname: desc('string', '用户昵称') }) }),
  op('get', '/inventory', 'getInventoryCn', '查询库存', undefined, {}),
  op('post', '/payments', 'createPaymentCn', '发起支付', undefined, { req: obj({ channel: desc('string', '支付渠道') }) }),
  op('get', '/refunds/{id}', 'getRefundCn', '查询退款状态', undefined, {}),
  op('get', '/products', 'listProductsJa', '商品一覧を取得', undefined, {}),
  op('get', '/products/{id}', 'getProductJa', '商品詳細を取得', undefined, {}),
  op('post', '/carts', 'createCartJa', 'カートを作成', undefined, {}),
  op('get', '/shipments/{id}', 'getShipmentJa', '配送状況を確認', undefined, {}),
  op('get', '/coupons', 'listCouponsJa', 'クーポン一覧', undefined, {}),
  op('get', '/guards', 'getGuardsJa', 'ガード設定を取得', undefined, {}),
  op('get', '/cards', 'listCardsJa', 'カード一覧を取得', undefined, {}),
], {});

// ---- erp: 1000 generated operations, noise and latency workload ----------------------------
function erp(n) {
  const resources = ['invoice', 'customer', 'order', 'shipment', 'warehouse', 'supplier', 'payment', 'refund', 'catalog', 'report'];
  const ops = [];
  for (let i = 0; i < n; i++) {
    const r = resources[i % resources.length];
    ops.push(op('get', `/erp/${r}s/v${i}/{id}`, `get_${r}_${i}`, `Fetch ${r} record ${i}`, `Legacy ERP ${r} lookup, partition ${i % 37}`, { tags: [`erp-${r}`], res: obj({ id: 'string', [`${r}Code`]: 'string', partition: 'integer' }) }));
  }
  return doc('ERP', ops, {});
}

fs.mkdirSync(out, { recursive: true });
for (const [name, d] of Object.entries({ shop, 'crm-a': crmA, 'crm-b': crmB, cjk, erp: erp(1000) })) {
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(d, null, 1) + '\n');
}
console.log('wrote', fs.readdirSync(out).join(', '));
