var axios = require('axios');
var FormData = require('form-data');

var BASE_URL = process.env.YODECK_BASE_URL || 'https://app.yodeck.com/api/v1';

function makeClient(token) {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: 'Token ' + token.trim()
    }
  });
}

function uploadMedia(token, fileBuffer, filename, mimetype, displayName) {
  var form = new FormData();
  form.append('file', fileBuffer, { filename: filename, contentType: mimetype });
  form.append('name', displayName || filename);

  return makeClient(token).post('/media/', form, {
    headers: Object.assign({}, form.getHeaders(), {
      Authorization: 'Token ' + token.trim()
    }),
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  }).then(function(res) {
    return res.data;
  });
}

function getScreens(token) {
  return makeClient(token).get('/monitor/').then(function(res) {
    return res.data.results || res.data;
  });
}

function addMediaToScreen(token, screenId, mediaId, duration) {
  var api = makeClient(token);
  return api.get('/monitor/' + screenId + '/').then(function(monitorRes) {
    var monitor = monitorRes.data;
    var playlistId = monitor.default_playlist;

    var getOrCreatePlaylist = playlistId
      ? Promise.resolve(playlistId)
      : api.post('/playlist/', {
          name: monitor.name + ' Playlist',
          description: 'Auto-created by Signage Portal'
        }).then(function(plRes) {
          var newId = plRes.data.id;
          return api.patch('/monitor/' + screenId + '/', {
            default_playlist: newId
          }).then(function() { return newId; });
        });

    return getOrCreatePlaylist.then(function(pid) {
      return api.get('/playlist/' + pid + '/').then(function(plRes) {
        var existingItems = plRes.data.playlistitem_set || [];
        var newItem = {
          media: mediaId,
          duration: duration || 10,
          ordering: existingItems.length + 1
        };
        return api.patch('/playlist/' + pid + '/', {
          playlistitem_set: existingItems.concat([newItem])
        });
      });
    });
  });
}

function verifyToken(token) {
  if (!token || !token.trim()) {
    return Promise.resolve({ valid: false, error: 'No token provided.' });
  }
  var cleanToken = token.trim();

  // Try 4 combinations: 2 URL formats x 2 auth header formats
  var urls = [
    'https://app.yodeck.com/api/v1',
    BASE_URL
  ];
  var headers = [
    { Authorization: 'Token ' + cleanToken },
    { Authorization: 'Api-Key ' + cleanToken }
  ];

  var attempts = [];
  urls.forEach(function(url) {
    headers.forEach(function(h) {
      attempts.push({ url: url + '/monitor/', headers: h });
    });
  });

  function tryNext(i) {
    if (i >= attempts.length) {
      return Promise.resolve({ valid: false, error: 'All API attempts failed. Please contact Yodeck support to confirm: (1) your account has Premium/Enterprise plan, (2) the API token has a role assigned, and (3) the correct API URL for your reseller account.' });
    }
    var attempt = attempts[i];
    console.log('Attempt ' + (i+1) + ': ' + JSON.stringify(attempt.headers).substring(0,40) + ' -> ' + attempt.url);
    return axios.get(attempt.url, { headers: attempt.headers }).then(function(res) {
      console.log('SUCCESS on attempt ' + (i+1) + ', status:', res.status);
      return { valid: true };
    }).catch(function(e) {
      var status = e.response && e.response.status;
      console.log('Attempt ' + (i+1) + ' failed, HTTP ' + status);
      if (status === 401) return { valid: false, error: 'Token rejected (401). In Yodeck go to: Account Settings -> Advanced Settings -> API Tokens. Delete existing token, click Generate Token, assign Administrator role, then copy the new token.' };
      if (status === 403) return { valid: false, error: 'Token valid but permission denied (403). Assign Administrator role to the token in Yodeck.' };
      return tryNext(i + 1);
    });
  }

  return tryNext(0);
}

module.exports = {
  uploadMedia: uploadMedia,
  getScreens: getScreens,
  addMediaToScreen: addMediaToScreen,
  verifyToken: verifyToken
};
