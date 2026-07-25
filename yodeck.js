// yodeck.js — Yodeck API v2
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

// ── Detect media type from mimetype ──────────────────────
function getMediaType(mimetype) {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype === 'application/pdf') return 'document';
  if (mimetype.includes('powerpoint') || mimetype.includes('presentation')) return 'document';
  if (mimetype.includes('word') || mimetype.includes('excel')) return 'document';
  return 'image';
}

// ── Upload media file ─────────────────────────────────────
// Yodeck requires media_origin as a JSON string field in multipart form
function uploadMedia(token, fileBuffer, filename, mimetype, displayName) {
  var mediaType = getMediaType(mimetype);
  var cleanToken = token.trim();
  var api = makeClient(cleanToken);

  console.log('Step 1: Creating media record, type:', mediaType, 'name:', displayName || filename);

  // Step 1: Create media record (single object, not bulk)
  return api.post('/media/', {
    name: displayName || filename,
    media_origin: {
      type: mediaType,
      source: 'local'
    },
    default_duration: 10
  }).then(function(res) {
    var mediaRecord = res.data;
    console.log('Media record created, id:', mediaRecord.id);

    // Step 2: Get S3 pre-signed upload URL - try multiple endpoint names
    console.log('Step 2: Getting S3 upload URL for media', mediaRecord.id);
    // Confirmed endpoint from API docs: GET /media/{id}/upload (no trailing slash)
    return api.get('/media/' + mediaRecord.id + '/upload').then(function(urlRes) {
      var uploadUrl = urlRes.data.upload_url;
      console.log('Got upload URL:', uploadUrl.substring(0, 60) + '...');

      // Step 3: Upload file directly to S3
      console.log('Step 3: Uploading file to S3...');
      return axios.put(uploadUrl, fileBuffer, {
        headers: {
          'Content-Type': mimetype,
          'Content-Length': fileBuffer.length
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }).then(function() {
        console.log('File uploaded to S3 successfully');

        // Step 4: Confirm upload - PUT /media/{id}/upload/complete
        console.log('Step 4: Confirming upload...');
        return api.put('/media/' + mediaRecord.id + '/upload/complete', {
          upload_url: uploadUrl
        }).then(function(confirmRes) {
          console.log('Upload confirmed:', confirmRes.data.details);
          return mediaRecord;
        });
      });
    });
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
  // Update each screen individually via PATCH /screens/{id}/
  var api = makeClient(token);
  return Promise.all(screenIds.map(function(id) {
    console.log('Assigning playlist', playlistId, 'to screen', id);
    return api.patch('/screens/' + id + '/', {
      screen_content: { source_id: Number(playlistId), source_type: 'playlist' }
    });
  })).then(function(results) {
    return results[0] && results[0].data;
  });
}

// ── Wait for Yodeck to finish processing an upload ────────
// Confirming the S3 upload only hands the file over; Yodeck then processes it
// asynchronously. Pushing a playlist whose newest item is still processing
// leaves the screen on its old content — which is why publishing and pushing
// back-to-back appeared to do nothing, while pushing from the portal minutes
// later worked. Never blocks publishing: on timeout or error it gives up and
// lets the caller proceed, which is no worse than not waiting at all.
function waitForMediaReady(token, mediaId, timeoutMs) {
  var api = makeClient(token);
  var deadline = Date.now() + (timeoutMs || 25000);
  var logged = false;

  function check() {
    return api.get('/media/' + mediaId + '/').then(function(res) {
      var m = res.data || {};
      if (!logged) { console.log('Media', mediaId, 'record fields:', Object.keys(m).join(',')); logged = true; }
      var status = m.status;
      console.log('Media', mediaId, 'status:', JSON.stringify(status));

      if (status == null) return 'unknown';
      // Observed in production: "encoding" while Yodeck processes the upload,
      // then "finished". The others are defensive — an unrecognised status just
      // keeps polling until the timeout, which is the old behaviour.
      if (/finished|ready|available|active|complete|success|done/i.test(String(status))) return 'ready';
      if (/fail|error/i.test(String(status))) { console.warn('Media', mediaId, 'reported failure:', status); return 'failed'; }
      if (Date.now() > deadline) { console.warn('Media', mediaId, 'still', status, 'at timeout; continuing anyway'); return 'timeout'; }
      return new Promise(function(r) { setTimeout(r, 1500); }).then(check);
    }).catch(function(e) {
      console.warn('Media status check failed:', e.message);
      return 'unknown';
    });
  }
  return check();
}

// ── Full publish: upload media + add to playlist ──────────
function publishToScreens(token, screenIds, fileBuffer, filename, mimetype, displayName, duration) {
  return uploadMedia(token, fileBuffer, filename, mimetype, displayName).then(function(media) {
    var chain = Promise.resolve([]);
    screenIds.forEach(function(screenId) {
      chain = chain.then(function(results) {
        return manageScreenPlaylist(token, screenId, media, duration).then(function(result) {
          results.push(result);
          return results;
        });
      });
    });
    return chain.then(function(results) {
      // Resolve only once the media is usable, so a push issued right after
      // this call lands on content the screen can actually display.
      return waitForMediaReady(token, media.id).then(function(readiness) {
        return { media: media, results: results, readiness: readiness };
      });
    });
  });
}

// ── Manage a single screen's playlist ────────────────────
function manageScreenPlaylist(token, screenId, media, duration) {
  var api = makeClient(token);

  return api.get('/screens/' + screenId + '/').then(function(res) {
    var screen = res.data;
    var content = screen.screen_content;

    console.log('Screen', screenId, 'content:', JSON.stringify(content));
    // If screen already has a playlist, add to it
    if (content && content.source_type === 'playlist' && content.source_id) {
      return api.get('/playlists/' + content.source_id + '/').then(function(plRes) {
        var playlist = plRes.data;
        var existingItems = playlist.items || [];
        var newItem = {
          id: media.id,
          type: 'media',
          duration: duration || 10,
          priority: existingItems.length + 1
        };
        return api.patch('/playlists/' + playlist.id + '/', {
          items: existingItems.concat([newItem])
        }).then(function() {
          console.log('Added media', media.id, 'to existing playlist', playlist.id);
          return { screenId: screenId, playlistId: playlist.id, action: 'added' };
        });
      });
    }

    // No playlist — create one and assign it
    var items = [{ id: media.id, type: 'media', duration: duration || 10, priority: 1 }];
    return api.post('/playlists/', {
      name: 'Portal Playlist - Screen ' + screenId,
      items: items
    }).then(function(plRes) {
      var newPlaylist = plRes.data;
      return api.patch('/screens/' + screenId + '/', {
        screen_content: { source_id: newPlaylist.id, source_type: 'playlist' }
      }).then(function() {
        console.log('Created playlist', newPlaylist.id, 'for screen', screenId);
        return { screenId: screenId, playlistId: newPlaylist.id, action: 'created' };
      });
    });
  });
}

// ── Takeover ──────────────────────────────────────────────
// Points a screen at a one-item playlist so a single file plays full screen,
// bypassing the normal playlist entirely. The screen's previous content is
// returned to the caller to store, because that is the only way to put it back.

function getScreenContent(token, screenId) {
  return makeClient(token).get('/screens/' + screenId + '/').then(function(res) {
    return { name: res.data.name, content: res.data.screen_content || null };
  });
}

function setScreenContent(token, screenId, content) {
  return makeClient(token).patch('/screens/' + screenId + '/', { screen_content: content });
}

function startTakeover(token, screenId, fileBuffer, filename, mimetype, displayName, duration) {
  var api = makeClient(token);
  var previous, media;

  return getScreenContent(token, screenId).then(function(info) {
    previous = info.content;
    console.log('Takeover: screen', screenId, 'previous content', JSON.stringify(previous));
    return uploadMedia(token, fileBuffer, filename, mimetype, displayName);
  }).then(function(m) {
    media = m;
    // Same encode wait as publishing — switching to media the screen cannot
    // render yet would leave the old playlist showing.
    return waitForMediaReady(token, media.id);
  }).then(function(readiness) {
    console.log('Takeover: media', media.id, 'readiness', readiness);
    return api.post('/playlists/', {
      name: 'Portal Takeover - Screen ' + screenId,
      items: [{ id: media.id, type: 'media', duration: duration || 30, priority: 1 }]
    });
  }).then(function(plRes) {
    var playlist = plRes.data;
    return setScreenContent(token, screenId, { source_id: playlist.id, source_type: 'playlist' })
      .then(function() { return pushToScreen(token, screenId); })
      .then(function() {
        console.log('Takeover: screen', screenId, 'now on playlist', playlist.id);
        return { previous: previous, playlistId: playlist.id, mediaId: media.id };
      });
  });
}

// Restoring must not depend on the takeover playlist still existing, so the
// screen is repointed first and cleanup is best-effort afterwards.
function endTakeover(token, screenId, previousContent, takeoverPlaylistId) {
  if (!previousContent || !previousContent.source_id) {
    return Promise.reject(new Error('No previous content recorded for screen ' + screenId));
  }
  return setScreenContent(token, screenId, {
    source_id: previousContent.source_id,
    source_type: previousContent.source_type || 'playlist'
  }).then(function() {
    return pushToScreen(token, screenId);
  }).then(function() {
    console.log('Takeover: screen', screenId, 'restored to', JSON.stringify(previousContent));
    if (takeoverPlaylistId) {
      return makeClient(token).delete('/playlists/' + takeoverPlaylistId + '/')
        .catch(function(e) { console.warn('Could not delete takeover playlist:', e.message); });
    }
  });
}

// ── Get screen's current playlist items ───────────────────
function getScreenPlaylist(token, screenId) {
  var api = makeClient(token);
  return api.get('/screens/' + screenId + '/').then(function(res) {
    var screen = res.data;
    var content = screen.screen_content;
    if (!content || content.source_type !== 'playlist' || !content.source_id) {
      return { screenId: screenId, screenName: screen.name, playlistId: null, items: [] };
    }
    return api.get('/playlists/' + content.source_id + '/').then(function(plRes) {
      var items = plRes.data.items || [];
      // Fetch media details for each item to get thumbnails
      var promises = items.map(function(item) {
        return api.get('/media/' + item.id + '/').then(function(mRes) {
          var media = mRes.data;
          if (media && Object.keys(media).length > 0) {
            console.log("Media fields sample:", JSON.stringify(Object.keys(media)));
            console.log("Media URLs:", JSON.stringify({ thumbnail_url: media.thumbnail_url, file_url: media.file_url, preview_url: media.preview_url, url: media.url }));
          }
          return Object.assign({}, item, {
            thumbnail_url: media.thumbnail_url || null,
            media_type: media.type || null
          });
        }).catch(function() {
          return item;
        });
      });
      return Promise.all(promises).then(function(enriched) {
        return {
          screenId: screenId,
          screenName: screen.name,
          playlistId: content.source_id,
          items: enriched
        };
      });
    });
  });
}

// ── Remove an item from a playlist ───────────────────────
function removeItemFromPlaylist(token, playlistId, mediaId) {
  var api = makeClient(token);
  return api.get('/playlists/' + playlistId + '/').then(function(res) {
    var items = (res.data.items || []).filter(function(item) {
      return String(item.id) !== String(mediaId);
    }).map(function(item, idx) {
      return Object.assign({}, item, { priority: idx + 1 });
    });
    return api.patch('/playlists/' + playlistId + '/', { items: items }).then(function(r) {
      return r.data;
    });
  });
}

function updatePlaylist(token, playlistId, items) {
  return makeClient(token).patch('/playlists/' + playlistId + '/', { items: items }).then(function(r) {
    return r.data;
  });
}

// Push content to a specific screen
function pushToScreen(token, screenId) {
  console.log('Pushing content to screen:', screenId);
  return makeClient(token).post('/screens/push', {
    filter_screens: [Number(screenId)]
  }).then(function(res) {
    console.log('Push response:', JSON.stringify(res.data));
    return res.data;
  });
}

module.exports = {
  updatePlaylist: updatePlaylist,
  pushToScreen: pushToScreen,
  verifyToken: verifyToken,
  getScreens: getScreens,
  uploadMedia: uploadMedia,
  publishToScreens: publishToScreens,
  getScreenPlaylist: getScreenPlaylist,
  removeItemFromPlaylist: removeItemFromPlaylist,
  startTakeover: startTakeover,
  endTakeover: endTakeover
};
