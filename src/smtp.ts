import { createConnection, type Socket } from 'node:net';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { config } from './config.js';

export function createSmtpTransport() {
  let socket: Socket | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const options: SMTPTransport.Options = {
    host: config.SMTP_HOST, port: config.SMTP_PORT,
    secure: config.SMTP_SECURE, requireTLS: config.SMTP_REQUIRE_TLS,
    ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } } : {}),
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000,
    disableFileAccess: true, disableUrlAccess: true,
    getSocket(_options, callback) {
      // Owning the underlying TCP socket gives the entire attempt a hard bound,
      // including DNS, TLS, and a peer that keeps resetting the inactivity timer.
      socket = createConnection({ host: config.SMTP_HOST, port: config.SMTP_PORT });
      let handedOff = false;
      const connectDeadline = setTimeout(() => socket?.destroy(new Error('TCP connection deadline exceeded')), 10000);
      deadline = setTimeout(() => socket?.destroy(new Error('Absolute SMTP deadline exceeded')), 60000);
      socket.once('error', (error) => {
        clearTimeout(connectDeadline);
        if (handedOff) return;
        // This marker is emitted only before Nodemailer receives any connection.
        callback(Object.assign(new Error('SMTP socket could not connect'), { code: 'EPRESMTP', cause: error }), {});
      });
      socket.once('connect', () => {
        handedOff = true;
        clearTimeout(connectDeadline);
        // Nodemailer performs implicit TLS / STARTTLS and certificate verification.
        callback(null, { connection: socket });
      });
    },
  };
  const transport = nodemailer.createTransport(options);
  return {
    transport,
    close() {
      if (deadline) clearTimeout(deadline);
      socket?.destroy();
      transport.close();
    },
  };
}
