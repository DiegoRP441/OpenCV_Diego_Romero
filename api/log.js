let faceTotal = 0;
let visitorsTotal = 0;
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
    const incFaces = Array.isArray(events)
      ? events.filter(e => e && e.type === 'faces_detected')
              .reduce((sum, e) => sum + (e.data?.count || 0), 0)
      : 0;
    faceTotal += incFaces;
    const incVisitors = Array.isArray(events)
      ? events.filter(e => e && e.type === 'app_enter').length
      : 0;
    visitorsTotal += incVisitors;

    const payload = { events, context, faceTotal, visitorsTotal };
    console.log('[client-logs]', JSON.stringify(payload, null, 2));

    // Optional: forward logs to external webhook for persistence
    const webhook = process.env.LOG_WEBHOOK_URL;
    if (webhook) {
      try {
        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (e) {
        console.error('[client-logs-forward-error]', e.message);
      }
    }

    return res.status(200).json({ ok: true, facesTotal: faceTotal, visitorsTotal });
  } catch (err) {
    console.error('[client-logs-error]', err);
    return res.status(400).json({ ok: false, error: err.message });
  }
}