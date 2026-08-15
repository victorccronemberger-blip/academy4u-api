// Erro de parsing do body JSON (express.json / body-parser): o cliente enviou
// um corpo malformado. É erro do CLIENTE (400), não interno (500) — sem esse
// tratamento um SyntaxError de "entity.parse.failed" vazava como 500 genérico.
import { isPoolQueueFullError } from "../store/pool-options.js";

function isBodyParseError(error) {
  return error?.type === "entity.parse.failed"
    || (error instanceof SyntaxError && error?.status === 400);
}

export function jsonErrorHandler(error, request, response, next) {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (isBodyParseError(error)) {
    console.error("ACADEMY4U API rejected malformed request body", {
      requestId: request.requestId,
      method: request.method,
      path: request.path,
      contentType: request.get("content-type"),
      message: error?.message,
    });
    response.status(400).json({
      error: "invalid_json",
      message: "O corpo da requisição não é um JSON válido.",
      requestId: request.requestId,
    });
    return;
  }
  // Fila do pool MySQL saturada: é sobrecarga transitória, não falha interna.
  // 503 com Retry-After sinaliza ao cliente/orquestrador para tentar depois.
  if (isPoolQueueFullError(error)) {
    console.error("ACADEMY4U API database pool queue saturated", {
      requestId: request.requestId,
      method: request.method,
      path: request.path,
    });
    response.set("Retry-After", "2");
    response.status(503).json({
      error: "service_overloaded",
      message: "O serviço está processando muitas solicitações. Tente novamente em instantes.",
      requestId: request.requestId,
    });
    return;
  }
  console.error("Unhandled ACADEMY4U API request error", {
    requestId: request.requestId,
    method: request.method,
    path: request.path,
    type: error?.name,
    code: error?.code,
    message: error?.message,
    stack: error?.stack,
  });
  response.status(500).json({
    error: "internal_error",
    message: "Não foi possível concluir a solicitação.",
    requestId: request.requestId,
  });
}
