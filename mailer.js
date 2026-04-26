// mailer.js — Email via SMTP2GO (port 2525, works on Railway)
var nodemailer = require('nodemailer');

function getTransport() {
  return nodemailer.createTransport({
    host: 'mail.smtp2go.com',
    port: 2525,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function sendPublishNotification(data) {
  var company = process.env.COMPANY_NAME || 'Signage Portal';
  return getTransport().sendMail({
    from: '"' + company + '" <' + process.env.SMTP_USER + '>',
    to: process.env.NOTIFY_EMAIL,
    subject: 'New content published — ' + data.clientName,
    html: '<div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">'
      + '<div style="background:#111827;padding:24px 28px"><h2 style="color:#f9fafb;margin:0">' + company + '</h2>'
      + '<p style="color:#9ca3af;margin:4px 0 0;font-size:13px">Content Publish Notification</p></div>'
      + '<div style="padding:28px">'
      + '<p style="color:#374151;font-size:15px;margin-top:0">A client just published new content to their digital signs.</p>'
      + '<table style="width:100%;border-collapse:collapse;font-size:14px">'
      + '<tr><td style="padding:8px 0;color:#6b7280;width:40%">Client</td><td style="color:#111827;font-weight:600">' + data.clientName + '</td></tr>'
      + '<tr><td style="padding:8px 0;color:#6b7280">Email</td><td>' + data.clientEmail + '</td></tr>'
      + '<tr><td style="padding:8px 0;color:#6b7280">File</td><td>' + data.filename + '</td></tr>'
      + '<tr><td style="padding:8px 0;color:#6b7280">Screen(s)</td><td>' + data.screenNames + '</td></tr>'
      + '<tr><td style="padding:8px 0;color:#6b7280">Published</td><td>' + data.publishedAt + '</td></tr>'
      + '</table></div>'
      + '<div style="background:#f9fafb;padding:16px 28px;font-size:12px;color:#9ca3af">Automated notification from ' + company + '</div>'
      + '</div>'
  }).then(function() {
    console.log('Publish notification sent to', process.env.NOTIFY_EMAIL);
  });
}

function sendWelcomeEmail(data) {
  var company = process.env.COMPANY_NAME || 'Signage Portal';
  return getTransport().sendMail({
    from: '"' + company + '" <' + process.env.SMTP_USER + '>',
    to: data.clientEmail,
    subject: 'Welcome to ' + company + ' Signage Portal',
    html: '<div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">'
      + '<div style="background:#111827;padding:24px 28px"><h2 style="color:#f9fafb;margin:0">' + company + '</h2></div>'
      + '<div style="padding:28px">'
      + '<p style="color:#374151;font-size:15px;margin-top:0">Hi ' + data.clientName + ', your portal access is ready.</p>'
      + '<div style="background:#f9fafb;border-radius:6px;padding:16px;margin:16px 0">'
      + '<p style="margin:0 0 8px;font-size:14px"><strong>Username:</strong> ' + data.username + '</p>'
      + '<p style="margin:0;font-size:14px"><strong>Password:</strong> ' + data.password + '</p>'
      + '</div>'
      + '<p style="color:#6b7280;font-size:13px">Please change your password after your first login.</p>'
      + '</div>'
      + '<div style="background:#f9fafb;padding:16px 28px;font-size:12px;color:#9ca3af">© ' + new Date().getFullYear() + ' ' + company + '</div>'
      + '</div>'
  }).then(function() {
    console.log('Welcome email sent to', data.clientEmail);
  });
}

module.exports = {
  sendPublishNotification: sendPublishNotification,
  sendWelcomeEmail: sendWelcomeEmail
};
