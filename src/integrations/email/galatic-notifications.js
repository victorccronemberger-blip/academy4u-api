import nodemailer from "nodemailer";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));

const money = (cents) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(cents || 0) / 100);
const shippingLabels = { label_created: "Etiqueta de envio criada", posted: "Pedido postado", in_transit: "Pedido em trânsito",
  out_for_delivery: "Pedido saiu para entrega", delivered: "Pedido entregue",
  delivery_exception: "Ocorrência na entrega", returned: "Pedido devolvido", shipment_canceled: "Envio cancelado" };

function configuration(source) {
  const host = source.GALATIC_SMTP_HOST?.trim() || source.SMTP_HOST?.trim();
  const user = source.GALATIC_SMTP_USER?.trim() || source.SMTP_USER?.trim();
  const password = source.GALATIC_SMTP_PASSWORD?.trim() || source.SMTP_PASSWORD?.trim();
  const from = source.GALATIC_MAIL_FROM?.trim() || source.SMTP_FROM?.trim() || user;
  if (!host || !user || !password || !from) return null;
  const port = Number(source.GALATIC_SMTP_PORT ?? 465);
  return { host, port: Number.isSafeInteger(port) ? port : 465,
    secure: String(source.GALATIC_SMTP_SECURE ?? "true").toLowerCase() === "true",
    auth: { user, pass: password }, from, name: source.GALATIC_MAIL_FROM_NAME?.trim() || "Galatic" };
}

function document(title, preview, body, action = null) {
  const safeTitle = escapeHtml(title); const safePreview = escapeHtml(preview);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${safeTitle}</title></head>
  <body style="margin:0;background:#0f0c16;color:#f7f1e8;font-family:Arial,sans-serif"><div style="display:none;max-height:0;overflow:hidden">${safePreview}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0f0c16;padding:32px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#171220;border:1px solid #352842;border-radius:20px;overflow:hidden">
  <tr><td style="padding:28px 34px;background:linear-gradient(135deg,#25162f,#11101b);border-bottom:3px solid #ff6b3d"><div style="font-size:22px;font-weight:900;letter-spacing:4px">GALATIC</div><div style="margin-top:7px;color:#b8aebf;font-size:11px;letter-spacing:2px">BOARDGAME STORE</div></td></tr>
  <tr><td style="padding:38px 34px"><div style="color:#ff8055;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase">Sua mesa. Sua história.</div><h1 style="font-size:30px;line-height:1.15;margin:15px 0;color:#fff">${safeTitle}</h1><div style="color:#d3cad8;font-size:15px;line-height:1.75">${body}</div>
  ${action ? `<a href="${escapeHtml(action.url)}" style="display:inline-block;margin-top:26px;background:#ff6b3d;color:#160b08;text-decoration:none;font-weight:900;padding:15px 22px;border-radius:11px">${escapeHtml(action.label)}</a>` : ""}
  <p style="margin:30px 0 0;color:#817789;font-size:12px;line-height:1.6">Se você não solicitou esta mensagem, ignore-a com segurança.</p></td></tr>
  <tr><td style="padding:22px 34px;border-top:1px solid #352842;color:#817789;font-size:11px;line-height:1.6">Galatic · Board games para transformar encontros em histórias.<br>Esta é uma mensagem transacional automática.</td></tr>
  </table></td></tr></table></body></html>`;
}

export function createGalaticNotifications(source = process.env) {
  const config = configuration(source);
  if (!config) return null;
  const transporter = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure,
    auth: config.auth, disableFileAccess: true, disableUrlAccess: true });
  const from = `"${config.name.replace(/[\r\n"]/g, "")}" <${config.from}>`;
  const origin = source.GALATIC_PUBLIC_ORIGIN?.trim() || "https://galatic.com.br";
  const send = (to, subject, html) => transporter.sendMail({ from, to, subject, html, text: subject });
  return Object.freeze({
    ready: true,
    verify: () => transporter.verify(),
    sendEmailVerification({ customer, token }) {
      const url = `${origin}/confirmar-email/?token=${encodeURIComponent(token)}`;
      return send(customer.email, "Confirme sua conta Galatic", document("Confirme sua conta", `Olá, ${customer.first_name}. Falta só confirmar seu e-mail.`,
        `<p>Olá, <strong>${escapeHtml(customer.first_name)}</strong>.</p><p>Sua conta Galatic foi criada. Confirme o endereço de e-mail para proteger seu acesso e acompanhar seus pedidos.</p>`,
        { label: "Confirmar meu e-mail", url }));
    },
    sendPasswordReset({ customer, token }) {
      const url = `${origin}/recuperar-acesso/?token=${encodeURIComponent(token)}`;
      return send(customer.email, "Redefinição de senha Galatic", document("Redefina sua senha", "Recebemos uma solicitação de recuperação de acesso.",
        `<p>Olá, <strong>${escapeHtml(customer.first_name)}</strong>.</p><p>Use o botão abaixo para criar uma nova senha. O link expira em 1 hora.</p>`,
        { label: "Criar nova senha", url }));
    },
    sendOrderCreated({ email, name, orderId, totalCents, method }) {
      return send(email, `Pedido Galatic ${orderId.slice(0, 8).toUpperCase()}`, document("Pedido recebido", "Recebemos seu pedido e estamos acompanhando o pagamento.",
        `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>O pedido <strong>${escapeHtml(orderId)}</strong> foi registrado no valor de <strong>${money(totalCents)}</strong>.</p><p>Pagamento: ${method === "pix" ? "Pix à vista" : "cartão de crédito"}.</p>`,
        { label: "Acompanhar pedido", url: `${origin}/pedido/?order_id=${encodeURIComponent(orderId)}` }));
    },
    sendPaymentConfirmed({ email, name, orderId }) {
      return send(email, "Pagamento confirmado · Galatic", document("Pagamento confirmado", "Seu pagamento foi confirmado e o pedido seguirá para preparação.",
        `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>O pagamento do pedido <strong>${escapeHtml(orderId)}</strong> foi confirmado. Agora começaremos a preparação para envio.</p>`,
        { label: "Ver meu pedido", url: `${origin}/pedido/?order_id=${encodeURIComponent(orderId)}` }));
    },
    sendPaymentCanceled({ email, name, orderId }) {
      return send(email, "Pedido cancelado · Galatic", document("Pedido cancelado", "A cobrança pendente foi cancelada com segurança.",
        `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>A cobrança do pedido <strong>${escapeHtml(orderId)}</strong> foi cancelada. Nenhum envio será realizado e o estoque reservado foi liberado.</p>`,
        { label: "Voltar à loja", url: `${origin}/loja/` }));
    },
    sendRefundRequested({ email, name, orderId }) {
      return send(email, "Estorno solicitado · Galatic", document("Estorno solicitado", "Recebemos a solicitação de devolução do pagamento.",
        `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>O estorno integral do pedido <strong>${escapeHtml(orderId)}</strong> foi solicitado ao processador de pagamento. Enviaremos outra atualização quando a devolução for confirmada.</p>`,
        { label: "Acompanhar pedido", url: `${origin}/pedido/?order_id=${encodeURIComponent(orderId)}` }));
    },
    sendPaymentReversed({ email, name, orderId, reason }) {
      const chargeback = reason === "chargeback";
      return send(email, chargeback ? "Contestação registrada · Galatic" : "Estorno confirmado · Galatic",
        document(chargeback ? "Pagamento contestado" : "Estorno confirmado",
          chargeback ? "O pagamento entrou em processo de contestação." : "A devolução do pagamento foi confirmada.",
          `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>${chargeback ? "Registramos uma contestação" : "O estorno foi confirmado"} para o pedido <strong>${escapeHtml(orderId)}</strong>.</p>`,
          { label: "Ver pedido", url: `${origin}/pedido/?order_id=${encodeURIComponent(orderId)}` }));
    },
    sendShippingUpdate({ email, name, orderId, status, trackingCode, description }) {
      const label = shippingLabels[status] || "Atualização da entrega";
      const tracking = trackingCode ? `<p>Código de rastreio: <strong>${escapeHtml(trackingCode)}</strong>.</p>` : "";
      const details = description ? `<p>${escapeHtml(description)}</p>` : "";
      return send(email, `${label} · Galatic`, document(label, `Novidades sobre a entrega do pedido ${orderId}.`,
        `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>Há uma atualização na entrega do pedido <strong>${escapeHtml(orderId)}</strong>.</p>${tracking}${details}`,
        { label: "Acompanhar entrega", url: `${origin}/pedido/?order_id=${encodeURIComponent(orderId)}` }));
    },
    previewCustom({ subject, message }) {
      const body = `<p>${escapeHtml(message).replace(/\r?\n/g, "<br>")}</p>`;
      return document(subject, subject, body);
    },
    sendCustom({ recipient, subject, message }) {
      const body = `<p>${escapeHtml(message).replace(/\r?\n/g, "<br>")}</p>`;
      return send(recipient, subject, document(subject, subject, body));
    },
  });
}
