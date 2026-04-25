// mailer.js — Gmail SMTP notifications
const nodemailer = require('nodemailer');

function getTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendPublishNotification({ clientName, clientEmail, filename, screenNames, publishedAt }) {
  const company = process.env.COMPANY_NAME || 'Signage Portal';
  const transport = getTransport();

  await transport.sendMail({
    from: `"${company}" <${process.env.SMTP_USER}>`,
    to: process.env.NOTIFY_EMAIL,
    subject: `📺 New content published — ${clientName}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
        <div style="background:#111827;padding:24px 28px">
          <h2 style="color:#f9fafb;margin:0;font-size:20px">${company}</h2>
          <p style="color:#9ca3af;margin:4px 0 0;font-size:13px">Content Publish Notification</p>
        </div>
        <div style="padding:28px">
          <p style="color:#374151;font-size:15px;margin-top:0">A client just published new content to their digital signs.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:8px 0;color:#6b7280;width:40%">Client</td><td style="color:#111827;font-weight:600">${clientName}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Email</td><td style="color:#111827">${clientEmail}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">File</td><td style="color:#111827">${filename}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Screen(s)</td><td style="color:#111827">${screenNames}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Published</td><td style="color:#111827">${publishedAt}</td></tr>
          </table>
        </div>
        <div style="background:#f9fafb;padding:16px 28px;font-size:12px;color:#9ca3af">
          This is an automated notification from ${company}'s signage portal.
        </div>
      </div>
    `
  });
}

async function sendWelcomeEmail({ clientName, clientEmail, username, password }) {
  const company = process.env.COMPANY_NAME || 'Signage Portal';
  const transport = getTransport();

  await transport.sendMail({
    from: `"${company}" <${process.env.SMTP_USER}>`,
    to: clientEmail,
    subject: `Welcome to ${company}'s Signage Portal`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
        <div style="background:#111827;padding:24px 28px">
          <h2 style="color:#f9fafb;margin:0;font-size:20px">${company}</h2>
          <p style="color:#9ca3af;margin:4px 0 0;font-size:13px">Digital Signage Portal</p>
        </div>
        <div style="padding:28px">
          <p style="color:#374151;font-size:15px;margin-top:0">Hi ${clientName}, your portal access is ready.</p>
          <p style="color:#374151;font-size:14px">Use the credentials below to log in and start publishing content to your digital screens:</p>
          <div style="background:#f9fafb;border-radius:6px;padding:16px;margin:16px 0">
            <p style="margin:0 0 8px;font-size:14px"><strong>Username:</strong> ${username}</p>
            <p style="margin:0;font-size:14px"><strong>Password:</strong> ${password}</p>
          </div>
          <p style="color:#6b7280;font-size:13px">Please change your password after your first login. If you have any questions, reply to this email.</p>
        </div>
        <div style="background:#f9fafb;padding:16px 28px;font-size:12px;color:#9ca3af">
          © ${new Date().getFullYear()} ${company}. All rights reserved.
        </div>
      </div>
    `
  });
}

module.exports = { sendPublishNotification, sendWelcomeEmail };
