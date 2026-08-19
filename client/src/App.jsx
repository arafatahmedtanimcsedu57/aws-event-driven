import { useEffect, useState } from 'react';
import { generateClient } from 'aws-amplify/api';
import { REST_URL } from './config';
import { fetchAuthSession } from 'aws-amplify/auth';

const client = generateClient();

const ON_ORDER_UPDATE = `
  subscription OnOrderUpdate {
    onOrderUpdate { orderId status customer }
  }
`;

export default function App({ signOut, user }) {
  const [orders, setOrders] = useState({});
  const [flashId, setFlashId] = useState(null);
  const [subError, setSubError] = useState(null);

// CHANNEL 1 — initial snapshot over REST, now authenticated
  useEffect(() => {
    (async () => {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        const r = await fetch(REST_URL, { headers: { Authorization: token } });
        const list = await r.json();
        const map = {};
        for (const o of list) map[o.orderId] = o;
        setOrders(map);
      } catch (e) {
        console.error('initial load failed', e);
      }
    })();
  }, []);

  useEffect(() => {
    const sub = client.graphql({ query: ON_ORDER_UPDATE }).subscribe({
      next: ({ data }) => {
        const o = data?.onOrderUpdate;
        if (!o) return;
        setOrders((prev) => ({ ...prev, [o.orderId]: o }));
        setFlashId(o.orderId);
        setTimeout(() => setFlashId(null), 1200);
      },
      error: (err) => {
        console.error('subscription error', err);
        setSubError('subscription failed — check console');
      },
    });
    return () => sub.unsubscribe();
  }, []);

  const rows = Object.values(orders);

  return (
    <div style={{ fontFamily: 'system-ui', padding: 24, maxWidth: 640, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Live Orders</h1>
        <div style={{ fontSize: 14, color: '#555' }}>
          {user?.signInDetails?.loginId ?? user?.username}{' '}
          <button onClick={signOut} style={{ marginLeft: 8 }}>Sign out</button>
        </div>
      </div>
      <p style={{ color: '#666' }}>
        Authenticated via Cognito · initial list over REST · live updates over AppSync.
      </p>
      {subError && <p style={{ color: 'crimson' }}>Subscription error: {subError}</p>}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
            <th style={{ padding: 8 }}>Order</th>
            <th style={{ padding: 8 }}>Customer</th>
            <th style={{ padding: 8 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.orderId} style={{
              borderBottom: '1px solid #eee',
              transition: 'background 0.6s',
              background: flashId === o.orderId ? '#fff6cc' : 'transparent',
            }}>
              <td style={{ padding: 8 }}>{o.orderId}</td>
              <td style={{ padding: 8 }}>{o.customer}</td>
              <td style={{ padding: 8 }}>{o.status}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={3} style={{ padding: 8, color: '#999' }}>No orders yet…</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}