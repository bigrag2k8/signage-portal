// yodeck.js — Yodeck API helper (per-client token)
const axios = require('axios');
const FormData = require('form-data');

const BASE_URL = 'https://app.yodeck.com/api/v1';

function client(token) {
  return axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Api-Key ${token}` }
  });
}

// Upload media file to Yodeck for a specific client
async function uploadMedia(token, fileBuffer, filename, mimetype, displayName) {
  const form = new FormData();
  form.append('file', fileBuffer, { filename, contentType: mimetype });
  form.append('name', displayName || filename);

  const res = await client(token).post('/media/', form, {
    headers: form.getHeaders(),
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

// Get a specific screen's current playlist
async function getPlaylist(token, screenId) {
  const res = await client(token).get(`/monitor/${screenId}/`);
  return res.data;
}

// Add media to a screen's playlist
async function addMediaToScreen(token, screenId, mediaId, duration) {
  // Fetch current monitor details
  const monitorRes = await client(token).get(`/monitor/${screenId}/`);
  const monitor = monitorRes.data;

  // Get or create a playlist
  let playlistId = monitor.default_playlist;

  if (!playlistId) {
    // Create a new playlist if none exists
    const plRes = await client(token).post('/playlist/', {
      name: `${monitor.name} Playlist`,
      description: 'Auto-created by Signage Portal'
    });
    playlistId = plRes.data.id;

    // Assign playlist to monitor
    await client(token).patch(`/monitor/${screenId}/`, {
      default_playlist: playlistId
    });
  }

  // Fetch existing playlist items
  const plRes = await client(token).get(`/playlist/${playlistId}/`);
  const existingItems = plRes.data.playlistitem_set || [];

  // Append new media item
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

// Verify a token is valid
async function verifyToken(token) {
  try {
    await client(token).get('/monitor/');
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { uploadMedia, getScreens, addMediaToScreen, verifyToken };
