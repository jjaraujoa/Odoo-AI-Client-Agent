export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function safeError(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: error.code, message: error.message, details: error.details },
    };
  }
  return {
    status: 500,
    body: { error: "internal_error", message: "Ocurrió un error interno." },
  };
}

