export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const { events = [], context = {} } = body;
    console.log('[client-logs]', JSON.stringify({ events, context }, null, 2));
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[client-logs-error]', err);
    return res.status(400).json({ ok: false, error: err.message });
  }
}