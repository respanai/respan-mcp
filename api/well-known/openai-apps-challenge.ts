import type { VercelRequest, VercelResponse } from '@vercel/node';

// Domain verification for the ChatGPT plugin: OpenAI's dashboard issues a
// token and checks that this URL returns it as plain text. Set the token in
// the OPENAI_APPS_CHALLENGE_TOKEN environment variable.
export default function handler(_req: VercelRequest, res: VercelResponse) {
  const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN?.trim();
  if (!token) {
    return res.status(404).send('Not found');
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.status(200).send(token);
}
