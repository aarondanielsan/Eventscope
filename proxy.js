const express = require('express');

function getAllowedOrigin(req) {
  const { origin } = req.headers;
  return origin ?? 'null';
}

function getLighthouseBaseUrl() {
  return process.env.LIGHTHOUSE_BASE_URL;
}

function applyCorsHeaders(req, res) {
  const allowOrigin = getAllowedOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
}

function ensureFetch() {
  if (typeof fetch === 'function') {
    return fetch.bind(globalThis);
  }
  throw new Error('Global fetch API is not available. Use Node 18+ or provide a fetch polyfill.');
}

async function forwardLighthouseRequest(req) {
  const lighthouseBaseUrl = getLighthouseBaseUrl();

  if (!lighthouseBaseUrl) {
    throw new Error('LIGHTHOUSE_BASE_URL environment variable is not configured');
  }

  const targetUrl = new URL('/lighthouse/getactions', lighthouseBaseUrl);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => params.append(key, entry));
    } else if (value !== undefined) {
      params.append(key, value);
    }
  }
  const queryString = params.toString();
  if (queryString) {
    targetUrl.search = queryString;
  }

  const proxiedResponse = await ensureFetch()(targetUrl, {
    method: 'GET',
    headers: {
      cookie: req.headers.cookie ?? '',
      'user-agent': req.headers['user-agent'] ?? 'Eventscope-Proxy',
      accept: req.headers.accept ?? 'application/json',
    },
    redirect: 'manual',
    credentials: 'include',
  });

  return proxiedResponse;
}

function createProxyRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    applyCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
      const requestedHeaders = req.headers['access-control-request-headers'];
      res.setHeader('Access-Control-Allow-Headers', requestedHeaders ?? 'Content-Type, Authorization');
      return res.sendStatus(204);
    }

    return next();
  });

  router.get('/lighthouse/getactions', async (req, res) => {
    applyCorsHeaders(req, res);

    try {
      const proxiedResponse = await forwardLighthouseRequest(req);
      res.status(proxiedResponse.status);

      proxiedResponse.headers.forEach((value, key) => {
        if (!['access-control-allow-origin', 'access-control-allow-credentials'].includes(key)) {
          res.setHeader(key, value);
        }
      });

      const body = await proxiedResponse.text();
      res.send(body);
    } catch (error) {
      console.error('Failed to proxy /lighthouse/getactions request', error);
      res.status(500).json({ error: 'Failed to proxy request' });
    }
  });

  return router;
}

module.exports = { createProxyRouter, applyCorsHeaders };
