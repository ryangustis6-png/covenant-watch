// Vercel serverless function: POST /api/memo {"borrower_id":"BOR-02"}
// Facts come from the server-side watchlist, never from the request body.
import watchlist from '../lib/generated-watchlist.js';
import {factsFor, draftMemo} from '../lib/memo.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error: 'POST only'});
  try {
    const id = typeof req.body === 'string' ? JSON.parse(req.body).borrower_id : req.body?.borrower_id;
    if (typeof id !== 'string' || !/^[A-Z0-9-]{1,20}$/.test(id)) return res.status(400).json({error: 'borrower_id required'});
    const facts = factsFor(watchlist, id);
    return res.status(200).json({...await draftMemo(facts), facts});
  } catch (e) {
    return res.status(400).json({error: e.message});
  }
}
