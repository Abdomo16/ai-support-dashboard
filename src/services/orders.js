import { db, invokeFunction, query } from './supabaseClient.js';
import { orgId } from './workspace.js';

export const ORDER_STATUSES = ['pending', 'paid', 'fulfilled', 'cancelled', 'refunded'];

export const listOrders = (status) => query('orders', `select=*,customers(id,full_name,phone)&org_id=eq.${orgId()}${status && status !== 'all' ? `&status=eq.${status}` : ''}&order=created_at.desc&limit=300`);

export async function saveOrder({ id, ...values }) {
  const total = (values.items || []).reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0);
  const patch = { ...values, total: Math.round(total * 1000) / 1000 };
  const rows = id ? await db.update('orders', `id=eq.${id}`, patch) : await db.insert('orders', { org_id: orgId(), ...patch });
  return rows[0];
}

export const setOrderStatus = (id, status) => db.update('orders', `id=eq.${id}`, { status, ...(status === 'paid' ? { paid_at: new Date().toISOString() } : {}) });
export const createPaymentLink = (orderId, { provider, send = false } = {}) => invokeFunction('payments', { org_id: orgId(), order_id: orderId, provider, send });

export const listProducts = (activeOnly = false) => query('products', `select=*&org_id=eq.${orgId()}${activeOnly ? '&is_active=eq.true' : ''}&order=name`);
export const saveProduct = ({ id, ...values }) => (id ? db.update('products', `id=eq.${id}`, values) : db.insert('products', { org_id: orgId(), ...values }));
export const deleteProduct = (id) => db.remove('products', `id=eq.${id}`);
