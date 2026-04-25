// yodeck.js — Yodeck API helper (per-client token)
const axios = require('axios');
const FormData = require('form-data');

const BASE_URL = 'https://app.yodeck.com/api/v1';

// Yodeck uses "Token <value>" format (Django REST Framework standard)
function client(token) {
  const cleanToken = token.trim();
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Token ${cleanToken}`,
      'Content-Type': 'application/json'
    }
  });
}

// Upload media file to Yodeck for a specific client
async function uploadMedia(token, fileBuffer, filename, mimetype, displayName) {
  const form = new FormData();
  form.append('file', fileBuffer, { filename, contentType: mimetype });
  form.append('name', displayName || filename);

  const res = await client(token).post('/media/', form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Token ${token.trim()}`
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });
  return res.data;
}

// Get all screens (monitors/players) for a specific client
async function getScreens(token) {
  const res = await client(token).get('/monitor/');
  return res.data.results || res.data;
}

// Add media to a screen's playlist
async function addMediaToScreen(token, screenId, mediaId, duration) {
  const monitorRes = await client(token).get(`/monitor/${screenId}/`);
  const monitor = monitorRes.data;

  let playlistId = monitor.default_playlist;

  if (!playlistId) {
    const plRes = await client(token).post('/playlist/', {
      name: `${monitor.name} Playlist`,
      description: 'Auto-created by Signage Portal'
    });
    playlistId = plRes.data.id;
    await client(token).patch(`/monitor/${screenId}/`, {
      default_playlist: playlistId
    });
  }

  const plRes = await client(token).get(`/playlist/${playlistId}/`);
  const existingItems = plRes.data.playlistitem_set || [];

  const newItem = {
    media: mediaId,
    duration: duration || 10,
    ordering: existingItems.length + 1
  };

  await client(token).patch(`/playlist/${playlistId}/`, {
    playlistitem_set: [...existingItems, newItem]
  });

  return { playlistId, mediaId };
}

// Verify a token — returns { valid, error } so we can show the real reason
async function verifyToken(token) {
  if (!token || !token.trim()) return { valid: false, error: 'No token provided' };

  try {
    const res = await client(token).get('/monitor/');
    return { valid: true };
  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data?.detail || e.response?.data || e.message;
    console.error(`Token verify failed — HTTP ${status}:`, detail);

    if (status === 401) return { valid: false, error: 'Token rejected by Yodeck (401 Unauthorized). Check the token is correct and has a role assigned.' };
    if (status === 403) return { valid: false, error: 'Token valid but lacks permission (403 Forbidden). Assign a higher role to the token in Yodeck.' };
    if (status === 404) return { valid: false, error: 'API endpoint not found. Account may not have API access (requires Premium/Enterprise).' };
    return { valid: false, error: `Error ${status}: ${JSON.stringify(detail)}` };
  }
}

module.exports = { uploadMedia, getScreens, addMediaToScreen, verifyToken };
