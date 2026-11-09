import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

const targets = [
    ['InterviewON home', 'https://interviewon.in/', /<title>InterviewON\s*\|/i],
    ['Candidate enquiries', 'https://interviewon.in/candidates.html', /id="candidate-enquiry-form"/i],
    ['Employer enquiries', 'https://interviewon.in/employers.html', /id="vacancy-form"/i],
];

const AGENT_TOKEN = process.env.AGENT_TOKEN ?? (process.env.AGENT_TOKEN_FILE ? readFileSync(process.env.AGENT_TOKEN_FILE, 'utf8').trim() : undefined);
const site = 'interviewon';
if (!AGENT_TOKEN || AGENT_TOKEN.length < 32) {
  throw new Error('Configure a random AGENT_TOKEN of at least 32 characters.');
}

const digest = value => createHash('sha256').update(value).digest();
const expected = digest('Bearer ' + AGENT_TOKEN);

async function check([name, url, marker]) {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      await response.body?.cancel();
      return { name, url, result: 'HTTP ' + response.status };
    }
    const result = marker.test(await response.text()) ? 'Passed' : 'Expected page content missing';
    return { name, url, result };
  } catch {
    return { name, url, result: 'Request failed or timed out' };
  }
}

function reply(response, status, data) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

let active = false;
let lastReport = null;
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    return reply(response, 200, { ok: true });
  }
  if (request.method !== 'POST' || request.url !== '/report') {
    return reply(response, 404, { error: 'Not found' });
  }
  if (!timingSafeEqual(digest(request.headers.authorization ?? ''), expected)) {
    return reply(response, 401, { error: 'Unauthorized' });
  }
  if (active) return reply(response, 429, { error: 'Report in progress' });
  if (lastReport && Date.now() - Date.parse(lastReport.checkedAt) < 60000) {
    return reply(response, 200, lastReport);
  }
  active = true;
  try {
    const checkedAt = new Date().toISOString();
    const checks = await Promise.all(targets.map(check));
    const passed = checks.filter(({ result }) => result === 'Passed').length;
    const details = checks.map(({ name, result }) => name + ': ' + result).join('; ');
    const summary = 'InterviewON public page checks: ' + passed + ' of ' + checks.length
      + ' passed. ' + details + '.';
    const aiStatus = 'Based on check results';
    lastReport = { site, checkedAt, checks, aiStatus, summary };
    reply(response, 200, lastReport);
  } finally {
    active = false;
  }
});
server.listen(Number(process.env.PORT ?? 8080), process.env.BIND_HOST ?? '0.0.0.0');
