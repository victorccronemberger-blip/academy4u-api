import nodemailer from "nodemailer";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));

const money = (cents) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(cents || 0) / 100);
const shippingLabels = { label_created: "Etiqueta de envio criada", posted: "Pedido postado", in_transit: "Pedido em trânsito",
  out_for_delivery: "Pedido saiu para entrega", delivered: "Pedido entregue",
  delivery_exception: "Ocorrência na entrega", returned: "Pedido devolvido", shipment_canceled: "Envio cancelado" };

const emailVisuals = Object.freeze({
  account: {
    eyebrow: "Conta e segurança",
    image: "https://galatic.com.br/assets/media/email/galatic-email-account-v1.jpg",
    alt: "Portal cósmico com símbolos de proteção da conta Galatic",
  },
  order: {
    eyebrow: "Pedido e pagamento",
    image: "https://galatic.com.br/assets/media/email/galatic-email-order-v1.jpg",
    alt: "Pedido Galatic em uma mesa de jogo cósmica",
  },
  shipping: {
    eyebrow: "Jornada do pedido",
    image: "https://galatic.com.br/assets/media/email/galatic-email-shipping-v1.jpg",
    alt: "Entrega Galatic percorrendo uma rota entre as estrelas",
  },
  community: {
    eyebrow: "Comunidade Galatic",
    image: "https://galatic.com.br/assets/media/email/galatic-email-community-v1.jpg",
    alt: "Jogadores reunidos em uma mesa cósmica Galatic",
  },
});

function smtpConfiguration(source) {
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

function hostingerConfiguration(source) {
  const token = source.GALATIC_MAIL_API_TOKEN?.trim();
  const mailboxResourceId = source.GALATIC_MAIL_API_MAILBOX_ID?.trim();
  if (!token || !mailboxResourceId) return null;
  const apiOrigin = (source.GALATIC_MAIL_API_ORIGIN?.trim() || "https://api.mail.hostinger.com").replace(/\/$/, "");
  return { token, mailboxResourceId, apiOrigin, name: source.GALATIC_MAIL_FROM_NAME?.trim() || "Galatic" };
}

async function hostingerRequest(config, path, options = {}) {
  const response = await fetch(`${config.apiOrigin}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Hostinger Mail API ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function renderDocument(title, preview, body, action = null, family = "community", salesEnabled = false) {
  const safeTitle = escapeHtml(title); const safePreview = escapeHtml(preview);
  const visual = emailVisuals[family] || emailVisuals.community;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"><title>${safeTitle}</title>
  <style>@media only screen and (max-width:640px){.email-shell{width:100%!important;border-radius:0!important}.email-pad{padding:28px 22px!important}.brand-pad{padding:19px 22px!important}.email-title{font-size:27px!important}.footer-copy{padding-left:14px!important}.email-canvas{padding:0!important}}</style></head>
  <body style="margin:0;padding:0;background:#eee8df;color:#f7f1e8;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${safePreview}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#eee8df"><tr><td class="email-canvas" align="center" style="padding:34px 12px">
  <table class="email-shell" role="presentation" width="620" cellspacing="0" cellpadding="0" border="0" style="width:620px;max-width:620px;background:#171220;border:1px solid #33283d;border-radius:22px;overflow:hidden;box-shadow:0 14px 40px rgba(18,12,28,.16)">
  <tr><td class="brand-pad" align="center" style="padding:21px 34px;background:#100d18;border-bottom:3px solid #f56b36"><a href="https://galatic.com.br/" style="display:inline-block;text-decoration:none"><img src="https://galatic.com.br/assets/media/brand/galatic-wordmark-email-v2.png" width="238" alt="Galatic Boardgame Store" style="display:block;width:238px;max-width:100%;height:auto;border:0"></a></td></tr>
  <tr><td style="padding:0;background:#090d18"><img src="${visual.image}" width="620" alt="${escapeHtml(visual.alt)}" style="display:block;width:100%;max-width:620px;height:auto;border:0"></td></tr>
  <tr><td class="email-pad" style="padding:40px 42px 42px;background:#171220"><div style="color:#ff8055;font-size:11px;font-weight:800;letter-spacing:2.2px;text-transform:uppercase">${escapeHtml(visual.eyebrow)}</div><h1 class="email-title" style="font-size:32px;line-height:1.16;margin:14px 0 18px;color:#fff;font-weight:800;letter-spacing:-.5px">${safeTitle}</h1><div style="color:#d8cfdd;font-size:15px;line-height:1.75">${body}</div>
  ${action ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:27px"><tr><td bgcolor="#ff6b3d" style="border-radius:12px"><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#ff6b3d;color:#160b08;text-decoration:none;font-size:14px;line-height:18px;font-weight:900;padding:15px 23px;border-radius:12px">${escapeHtml(action.label)} &nbsp;→</a></td></tr></table>` : ""}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:32px;border-top:1px solid #352a3f"><tr><td style="padding-top:19px;color:#8f8596;font-size:12px;line-height:1.65">Precisa de ajuda? Responda este e-mail ou acesse nossa <a href="https://galatic.com.br/ajuda/" style="color:#ff8055;text-decoration:underline">Central de ajuda</a>.</td></tr></table></td></tr>
  <tr><td style="padding:25px 32px;background:#f7f0e7;color:#15111d"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td width="58" valign="top"><a href="https://galatic.com.br/" style="text-decoration:none"><img src="https://galatic.com.br/favicon-galatic-20260818-192.png" width="52" height="52" alt="Galatic" style="display:block;width:52px;height:52px;border:0;border-radius:12px"></a></td><td class="footer-copy" valign="top" style="padding-left:17px;color:#5e5664;font-size:11px;line-height:1.65"><strong style="display:block;color:#171220;font-size:13px;margin-bottom:2px">Galatic Boardgame Store</strong>Sua mesa. Sua história.<br>galatic.com.br${salesEnabled ? "" : " · Operação em preparação"} · <a href="mailto:comercial@galatic.com.br" style="color:#c54f27">comercial@galatic.com.br</a><br><a href="https://galatic.com.br/politicas/privacidade/" style="color:#5e5664">Privacidade</a> &nbsp;·&nbsp; <a href="https://galatic.com.br/politicas/termos/" style="color:#5e5664">Termos de uso</a></td></tr></table></td></tr>
  <tr><td align="center" style="padding:12px 20px;background:#ff6b3d;color:#25100a;font-size:9px;font-weight:800;letter-spacing:1.7px;text-transform:uppercase">Encontros que viram histórias</td></tr>
  </table></td></tr></table></body></html>`;
}

function renderTextDocument(title, preview, body, action, extraLinks, salesEnabled) {
  const lines = [
    "Galatic Boardgame Store",
    "Sua mesa. Sua história.",
    "",
    title,
    preview,
    "",
    body,
    action ? `${action.label}:\n${action.url}` : "",
    ...extraLinks.map(({ label, url }) => `${label}:\n${url}`),
    "",
    "Precisa de ajuda? Responda este e-mail ou acesse nossa Central de ajuda:",
    "https://galatic.com.br/ajuda/",
    "",
    `galatic.com.br${salesEnabled ? "" : " · Operação em preparação"}`,
    "comercial@galatic.com.br",
    "Privacidade: https://galatic.com.br/politicas/privacidade/",
    "Termos de uso: https://galatic.com.br/politicas/termos/",
  ];
  return lines.filter((line, index) => line || (index > 0 && lines[index - 1])).join("\n");
}

export function createGalaticNotifications(source = process.env) {
  const hostinger = hostingerConfiguration(source);
  const smtp = smtpConfiguration(source);
  if (!hostinger && !smtp) return null;
  const transporter = smtp ? nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure,
    auth: smtp.auth, disableFileAccess: true, disableUrlAccess: true }) : null;
  const from = smtp ? `"${smtp.name.replace(/[\r\n"]/g, "")}" <${smtp.from}>` : null;
  const salesEnabled = String(source.GALATIC_SALES_ENABLED ?? "false").trim().toLowerCase() === "true";
  const document = (title, preview, body, action = null, family = "community", plainBody = preview, extraLinks = []) => ({
    html: renderDocument(title, preview, body, action, family, salesEnabled),
    text: renderTextDocument(title, preview, plainBody, action, extraLinks, salesEnabled),
  });
  const origin = source.GALATIC_PUBLIC_ORIGIN?.trim() || "https://galatic.com.br";
  const operationalRecipient = source.GALATIC_ADMIN_EMAIL?.trim() || null;
  const send = hostinger
    ? (to, subject, message) => hostingerRequest(hostinger,
      `/api/v1/mailboxes/${encodeURIComponent(hostinger.mailboxResourceId)}/send`, {
        method: "POST",
        body: JSON.stringify({ to: [to], subject, html: message.html, text: message.text, displayName: hostinger.name }),
      })
    : (to, subject, message) => transporter.sendMail({ from, to, subject, html: message.html, text: message.text });
  return Object.freeze({
    ready: true,
    provider: hostinger ? "hostinger-mail-api" : "smtp",
    verify: async () => {
      if (!hostinger) return transporter.verify();
      const account = await hostingerRequest(hostinger, "/api/v1/me");
      const mailboxes = account?.data?.mailboxes ?? [];
      if (!mailboxes.some((mailbox) => mailbox.resourceId === hostinger.mailboxResourceId)) {
        throw new Error("A caixa configurada não pertence ao token da Hostinger Mail API.");
      }
      return true;
    },
    sendEmailVerification({ customer, token }) {
      const url = `${origin}/confirmar-email/?token=${encodeURIComponent(token)}`;
      return send(customer.email, "Confirme sua conta Galatic", document("Confirme sua conta", `Olá, ${customer.first_name}. Falta só confirmar seu e-mail.`,
        `<p>Olá, <strong>${escapeHtml(customer.first_name)}</strong>.</p><p>Sua conta Galatic foi criada. Confirme o endereço de e-mail para proteger seu acesso e acompanhar seus pedidos.</p>`,
        { label: "Confirmar meu e-mail", url }, "account",
        `Olá, ${customer.first_name}.\nSua conta Galatic foi criada. Confirme seu endereço de e-mail para proteger seu acesso e acompanhar seus pedidos.`));
    },
    sendWelcome({ customer }) {
      return send(customer.email, "Conta confirmada · Galatic", document("Sua conta está pronta", "Seu e-mail foi confirmado e sua conta Galatic já está protegida.",
        `<p>Olá, <strong>${escapeHtml(customer.first_name)}</strong>.</p><p>Seu e-mail foi confirmado. Agora você pode salvar favoritos, acompanhar pedidos e manter seus dados de entrega organizados em um só lugar.</p>`,
        { label: "Acessar minha conta", url: `${origin}/minha-conta/` }, "account",
        `Olá, ${customer.first_name}.\nSeu e-mail foi confirmado. Agora você pode salvar favoritos, acompanhar pedidos e manter seus dados de entrega organizados em um só lugar.`));
    },
    sendPasswordReset({ customer, token }) {
      const url = `${origin}/recuperar-acesso/?token=${encodeURIComponent(token)}`;
      return send(customer.email, "Redefinição de senha Galatic", document("Redefina sua senha", "Recebemos uma solicitação de recuperação de acesso.",
        `<p>Olá, <strong>${escapeHtml(customer.first_name)}</strong>.</p><p>Use o botão abaixo para criar uma nova senha. O link expira em 1 hora.</p>`,
        { label: "Criar nova senha", url }, "account",
        `Olá, ${customer.first_name}.\nUse o link abaixo para criar uma nova senha. O link expira em 1 hora.`));
    },
    sendPasswordChanged({ customer }) {
      return send(customer.email, "Senha alterada · Galatic", document("Sua senha foi alterada", "A senha da sua conta Galatic foi atualizada com sucesso.",
        `<p>Olá, <strong>${escapeHtml(customer.first_name)}</strong>.</p><p>Sua senha foi alterada. Se você não realizou essa mudança, recupere o acesso imediatamente e entre em contato com a Galatic.</p>`,
        { label: "Entrar na minha conta", url: `${origin}/entrar/` }, "account",
        `Olá, ${customer.first_name}.\nSua senha foi alterada. Se você não realizou essa mudança, recupere o acesso imediatamente e entre em contato com a Galatic.`));
    },
    sendNewsletterVerification({ email, token }) {
      const url = `${origin}/newsletter/confirmar/?token=${encodeURIComponent(token)}`;
      return send(email, "Confirme sua inscrição · Carta da Mesa", document("Confirme sua inscrição", "Só falta confirmar que este endereço pertence a você.",
        `<p>Você pediu para receber a Carta da Mesa.</p><p>Confirme sua inscrição para receber seleções de jogos, guias e novidades da Galatic.</p>`,
        { label: "Confirmar inscrição", url }, "community",
        "Você pediu para receber a Carta da Mesa.\nConfirme sua inscrição para receber seleções de jogos, guias e novidades da Galatic."));
    },
    sendNewsletterConfirmed({ email, unsubscribeToken }) {
      const unsubscribeUrl = `${origin}/newsletter/descadastrar/?token=${encodeURIComponent(unsubscribeToken)}`;
      return send(email, "Inscrição confirmada · Carta da Mesa", document("Bem-vindo à Carta da Mesa", "Sua inscrição nas novidades da Galatic foi confirmada.",
        `<p>Sua inscrição está ativa.</p><p>Você receberá seleções de jogos, guias e novidades da Galatic. Nada de excesso: somente conteúdo útil para escolher melhor a próxima partida.</p><p style="font-size:12px;color:#817789">Você pode <a href="${escapeHtml(unsubscribeUrl)}" style="color:#ff8055">cancelar a inscrição a qualquer momento</a>.</p>`,
        { label: "Explorar a Galatic", url: `${origin}/loja/` }, "community",
        "Sua inscrição está ativa.\nVocê receberá seleções de jogos, guias e novidades da Galatic. Nada de excesso: somente conteúdo útil para escolher melhor a próxima partida.\nVocê pode cancelar a inscrição a qualquer momento.",
        [{ label: "Cancelar inscrição", url: unsubscribeUrl }]));
    },
    sendNewsletterUnsubscribed({ email }) {
      return send(email, "Inscrição cancelada · Carta da Mesa", document("Inscrição cancelada", "Sua preferência foi atualizada.",
        `<p>Seu endereço foi removido da Carta da Mesa e não receberá novos e-mails de novidades.</p><p>Você poderá se inscrever novamente quando quiser.</p>`,
        { label: "Voltar à Galatic", url: `${origin}/` }, "community",
        "Seu endereço foi removido da Carta da Mesa e não receberá novos e-mails de novidades.\nVocê poderá se inscrever novamente quando quiser."));
    },
    sendContactReceived({ email, name, protocol, subject }) {
      return send(email, `Recebemos sua mensagem · ${escapeHtml(protocol)}`, document("Mensagem recebida", "A equipe Galatic recebeu sua solicitação.",
        `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>Registramos sua mensagem sobre <strong>${escapeHtml(subject)}</strong>.</p><p>Protocolo: <strong>${escapeHtml(protocol)}</strong>.</p><p>Responderemos pelo mesmo endereço de e-mail.</p>`,
        { label: "Central de ajuda", url: `${origin}/ajuda/` }, "community",
        `Olá, ${name}.\nRegistramos sua mensagem sobre ${subject}.\nProtocolo: ${protocol}.\nResponderemos pelo mesmo endereço de e-mail.`));
    },
    sendContactAlert({ email, name, protocol, subject }) {
      if (!operationalRecipient) return Promise.resolve({ skipped: true });
      return send(operationalRecipient, `Novo atendimento Galatic · ${escapeHtml(protocol)}`, document("Novo atendimento recebido", "Uma nova mensagem aguarda resposta no painel administrativo.",
        `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) enviou uma mensagem sobre <strong>${escapeHtml(subject)}</strong>.</p><p>Protocolo: <strong>${escapeHtml(protocol)}</strong>.</p>`,
        { label: "Abrir atendimento", url: `${origin}/admin/atendimento/` }, "community",
        `${name} (${email}) enviou uma mensagem sobre ${subject}.\nProtocolo: ${protocol}.`));
    },
    sendOrderCreated({ email, name, orderId, totalCents, method }) {
      return send(email, `Pedido Galatic ${orderId.slice(0, 8).toUpperCase()}`, document("Pedido recebido", "Recebemos seu pedido e estamos acompanhando o pagamento.",
        `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>O pedido <strong>${escapeHtml(orderId)}</strong> foi registrado no valor de <strong>${money(totalCents)}</strong>.</p><p>Pagamento: ${method === "pix" ? "Pix à vista" : "cartão de crédito"}.</p>`,
        { label: "Acompanhar pedido", url: `${origin}/pedido/?order_id=${encodeURIComponent(orderId)}` }, "order",
        `Olá, ${name}.\nO pedido ${orderId} foi registrado no valor de ${money(totalCents)}.\nPagamento: ${method === "pix" ? "Pix à vista" : "cartão de crédito"}.`));
    },
    sendPaymentConfirmed({ email, name, orderId }) {
      return send(email, "Pagamento confirmado · Galatic", document("Pagamento confirmado", "Seu pagamento foi confirmado e o pedido seguirá para preparação.",
        `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>O pagamento do pedido <strong>${escapeHtml(orderId)}</strong> foi confirmado. Agora começaremos a preparação para envio.</p>`,
        { label: "Ver meu pedido", url: `${origin}/pedido/?order_id=${encodeURIComponent(orderId)}` }, "order",
        `Olá, ${name}.\nO pagamento do pedido ${orderId} foi confirmado. Agora começaremos a preparação para envio.`));
    },
    sendPaymentCanceled({ email, name, orderId }) {
      return send(email, "Pedido cancelado · Galatic", document("Pedido cancelado", "A cobrança pendente foi cancelada com segurança.",
        `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>A cobrança do pedido <strong>${escapeHtml(orderId)}</strong> foi cancelada. Nenhum envio será realizado e o estoque reservado foi liberado.</p>`,
        { label: "Voltar à loja", url: `${origin}/loja/` }, "order",
        `Olá, ${name}.\nA cobrança do pedido ${orderId} foi cancelada. Nenhum envio será realizado e o estoque reservado foi liberado.`));
    },
    sendRefundRequested({ email, name, orderId }) {
      return send(email, "Estorno solicitado · Galatic", document("Estorno solicitado", "Recebemos a solicitação de devolução do pagamento.",
        `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>O estorno integral do pedido <strong>${escapeHtml(orderId)}</strong> foi solicitado ao processador de pagamento. Enviaremos outra atualização quando a devolução for confirmada.</p>`,
        { label: "Acompanhar pedido", url: `${origin}/pedido/?order_id=${encodeURIComponent(orderId)}` }, "order",
        `Olá, ${name}.\nO estorno integral do pedido ${orderId} foi solicitado ao processador de pagamento. Enviaremos outra atualização quando a devolução for confirmada.`));
    },
    sendPaymentReversed({ email, name, orderId, reason }) {
      const chargeback = reason === "chargeback";
      return send(email, chargeback ? "Contestação registrada · Galatic" : "Estorno confirmado · Galatic",
        document(chargeback ? "Pagamento contestado" : "Estorno confirmado",
          chargeback ? "O pagamento entrou em processo de contestação." : "A devolução do pagamento foi confirmada.",
          `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>${chargeback ? "Registramos uma contestação" : "O estorno foi confirmado"} para o pedido <strong>${escapeHtml(orderId)}</strong>.</p>`,
          { label: "Ver pedido", url: `${origin}/pedido/?order_id=${encodeURIComponent(orderId)}` }, "order",
          `Olá, ${name}.\n${chargeback ? "Registramos uma contestação" : "O estorno foi confirmado"} para o pedido ${orderId}.`));
    },
    sendShippingUpdate({ email, name, orderId, status, trackingCode, description }) {
      const label = shippingLabels[status] || "Atualização da entrega";
      const tracking = trackingCode ? `<p>Código de rastreio: <strong>${escapeHtml(trackingCode)}</strong>.</p>` : "";
      const details = description ? `<p>${escapeHtml(description)}</p>` : "";
      return send(email, `${label} · Galatic`, document(label, `Novidades sobre a entrega do pedido ${orderId}.`,
        `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>Há uma atualização na entrega do pedido <strong>${escapeHtml(orderId)}</strong>.</p>${tracking}${details}`,
        { label: "Acompanhar entrega", url: `${origin}/pedido/?order_id=${encodeURIComponent(orderId)}` }, "shipping",
        `Olá, ${name}.\nHá uma atualização na entrega do pedido ${orderId}.${trackingCode ? `\nCódigo de rastreio: ${trackingCode}.` : ""}${description ? `\n${description}` : ""}`));
    },
    previewCustom({ subject, message }) {
      const body = `<p>${escapeHtml(message).replace(/\r?\n/g, "<br>")}</p>`;
      return document(subject, subject, body, null, "community", String(message ?? "")).html;
    },
    sendCustom({ recipient, subject, message }) {
      const body = `<p>${escapeHtml(message).replace(/\r?\n/g, "<br>")}</p>`;
      return send(recipient, subject, document(subject, subject, body, null, "community", String(message ?? "")));
    },
  });
}
