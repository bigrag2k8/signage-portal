// yodeck.js — Yodeck API v2 with full playlist management
var axios = require('axios');
var FormData = require('form-data');

var BASE_URL = 'https://app.yodeck.com/api/v2';

function makeClient(token) {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: 'Token ' + token.trim(),
      'Content-Type': 'application/json'
    }
  });
}

// ── Verify token ──────────────────────────────────────────
function verifyToken(token) {
  if (!token || !token.trim()) {
    return Promise.resolve({ valid: false, error: 'No token provided.' });
  }
  return makeClient(token.trim()).get('/screens/').then(function() {
    return { valid: true };
  }).catch(function(e) {
    var status = e.response && e.response.status;
    if (status === 401) return { valid: false, error: 'Token rejected (401). Format must be label:tokenvalue — e.g. portal:XXXXXXXXX. Make sure a Role was assigned.' };
    if (status === 403) return { valid: false, error: 'Permission denied (403). Assign Administrator role to the token in Yodeck.' };
    return { valid: false, error: 'HTTP ' + status + ': Could not connect to Yodeck API.' };
  });
}

// ── Get all screens ───────────────────────────────────────
function getScreens(token) {
  return makeClient(token).get('/screens/').then(function(res) {
    return res.data.results || res.data;
  });
}

// ── Upload media file ─────────────────────────────────────
function uploadMedia(token, fileBuffer, filename, mimetype, displayName) {
  var form = new FormData();
  form.append('file', fileBuffer, { filename: filename, contentType: mimetype });
  form.append('name', displayName || filename);

  return axios.post(BASE_URL + '/media/', form, {
    headers: Object.assign({}, form.getHeaders(), {
      Authorization: 'Token ' + token.trim()
    }),
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  }).then(function(res) {
    console.log('Media uploaded, id:', res.data.id, 'name:', res.data.name);
    return res.data;
  });
}

// ── Get all playlists ─────────────────────────────────────
function getPlaylists(token) {
  return makeClient(token).get('/playlists/').then(function(res) {
    return res.data.results || res.data;
  });
}

// ── Get single playlist with items ────────────────────────
function getPlaylist(token, playlistId) {
  return makeClient(token).get('/playlists/' + playlistId + '/').then(function(res) {
    return res.data;
  });
}

// ── Create a new playlist ─────────────────────────────────
function createPlaylist(token, name, items) {
  return makeClient(token).post('/playlists/', {
    name: name,
    items: items || []
  }).then(function(res) {
    console.log('Playlist created, id:', res.data.id);
    return res.data;
  });
}

// ── Update playlist items (add/remove/reorder) ────────────
function updatePlaylist(token, playlistId, items) {
  return makeClient(token).patch('/playlists/' + playlistId + '/', {
    items: items
  }).then(function(res) {
    return res.data;
  });
}

// ── Assign playlist to screens ────────────────────────────
function assignPlaylistToScreens(token, screenIds, playlistId) {
  var objects = screenIds.map(function(id) {
    return {
      id: Number(id),
      screen_content: {
        source_id: Number(playlistId),
        source_type: 'playlist'
      }
    };
  });

  return makeClient(token).patch('/screens/', { objects: objects }).then(function(res) {
    console.log('Playlist', playlistId, 'assigned to screens:', screenIds);
    return res.data;
  });
}

// ── Assign media directly to screens ─────────────────────
function assignMediaToScreens(token, screenIds, mediaId) {
  var objects = screenIds.map(function(id) {
    return {
      id: Number(id),
      screen_content: {
        source_id: Number(mediaId),
        source_type: 'media'
      }
    };
  });

  return makeClient(token).patch('/screens/', { objects: objects }).then(function(res) {
    console.log('Media', mediaId, 'assigned to screens:', screenIds);
    return res.data;
  });
}

// ── Full publish flow: upload + add to playlist + assign ──
// If screen already has a portal-managed playlist, add to it.
// Otherwise create a new playlist and assign it.
function publishToScreens(token, screenIds, fileBuffer, filename, mimetype, displayName, duration) {
  var mediaObj;

  // Step 1: Upload the media
  return uploadMedia(token, fileBuffer, filename, mimetype, displayName).then(function(media) {
    mediaObj = media;

    // Step 2: For each screen, get current content and manage playlist
    var chain = Promise.resolve([]);
    screenIds.forEach(function(screenId) {
      chain = chain.then(function(results) {
        return manageScreenPlaylist(token, screenId, mediaObj, duration).then(function(result) {
          results.push(result);
          return results;
        });
      });
    });
    return chain;
  }).then(function(results) {
    return { media: mediaObj, results: results };
  });
}

// ── Manage a single screen's playlist ────────────────────
function manageScreenPlaylist(token, screenId, media, duration) {
  var api = makeClient(token);

  return api.get('/screens/' + screenId + '/').then(function(res) {
    var screen = res.data;
    var content = screen.screen_content;

    // If screen already has a playlist assigned, add to it
    if (content && content.source_type === 'playlist' && content.source_id) {
      return api.get('/playlists/' + content.source_id + '/').then(function(plRes) {
        var playlist = plRes.data;
        var existingItems = playlist.items || [];

        // Build new items array with the new media appended
        var newItem = {
          id: media.id,
          type: 'media',
          duration: duration || 10,
          priority: existingItems.length + 1
        };

        var updatedItems = existingItems.concat([newItem]);

        return api.patch('/playlists/' + playlist.id + '/', {
          items: updatedItems
        }).then(function() {
          console.log('Added media', media.id, 'to existing playlist', playlist.id, 'on screen', screenId);
          return { screenId: screenId, playlistId: playlist.id, action: 'added_to_existing' };
        });
      });
    }

    // No playlist — create a new one and assign it
    var newPlaylistName = 'Portal Playlist - Screen ' + screenId;
    var items = [{
      id: media.id,
      type: 'media',
      duration: duration || 10,
      priority: 1
    }];

    return api.post('/playlists/', { name: newPlaylistName, items: items }).then(function(plRes) {
      var newPlaylist = plRes.data;
      return api.patch('/screens/', {
        objects: [{
          id: Number(screenId),
          screen_content: {
            source_id: newPlaylist.id,
            source_type: 'playlist'
          }
        }]
      }).then(function() {
        console.log('Created playlist', newPlaylist.id, 'and assigned to screen', screenId);
        return { screenId: screenId, playlistId: newPlaylist.id, action: 'created_new' };
      });
    });
  });
}

// ── Get screen's current playlist items ───────────────────
function getScreenPlaylist(token, screenId) {
  return makeClient(token).get('/screens/' + screenId + '/').then(function(res) {
    var screen = res.data;
    var content = screen.screen_content;

    if (!content || content.source_type !== 'playlist' || !content.source_id) {
      return { screenId: screenId, screenName: screen.name, playlistId: null, items: [] };
    }

    return makeClient(token).get('/playlists/' + content.source_id + '/').then(function(plRes) {
      return {
        screenId: screenId,
        screenName: screen.name,
        playlistId: content.source_id,
        items: plRes.data.items || []
      };
    });
  });
}

// ── Remove a media item from a screen's playlist ──────────
function removeItemFromPlaylist(token, playlistId, mediaId) {
  return makeClient(token).get('/playlists/' + playlistId + '/').then(function(res) {
    var items = res.data.items || [];
    var filtered = items.filter(function(item) {
      return String(item.id) !== String(mediaId);
    });
    // Re-assign priorities
    filtered = filtered.map(function(item, idx) {
      return Object.assign({}, item, { priority: idx + 1 });
    });

    return makeClient(token).patch('/playlists/' + playlistId + '/', {
      items: filtered
    }).then(function(plRes) {
      return plRes.data;
    });
  });
}

module.exports = {
  verifyToken: verifyToken,
  getScreens: getScreens,
  uploadMedia: uploadMedia,
  getPlaylists: getPlaylists,
  getPlaylist: getPlaylist,
  createPlaylist: createPlaylist,
  updatePlaylist: updatePlaylist,
  assignPlaylistToScreens: assignPlaylistToScreens,
  assignMediaToScreens: assignMediaToScreens,
  publishToScreens: publishToScreens,
  getScreenPlaylist: getScreenPlaylist,
  removeItemFromPlaylist: removeItemFromPlaylist
};
