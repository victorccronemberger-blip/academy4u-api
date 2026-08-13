import { randomUUID } from "node:crypto";

export function requestContext(request, response, next) {
  request.requestId = randomUUID();
  response.set("X-Request-Id", request.requestId);
  next();
}
