import { handler } from '../../server.mjs';

export const config = { api: { bodyParser: false, responseLimit: false }, maxDuration: 60 };
export default handler;
