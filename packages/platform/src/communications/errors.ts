export class CommunicationRecipientNotFoundError extends Error {
  constructor(message = "Communication recipient not found") {
    super(message);
    this.name = "CommunicationRecipientNotFoundError";
  }
}

export class CommunicationTemplateNotFoundError extends Error {
  constructor(message = "Communication template not found") {
    super(message);
    this.name = "CommunicationTemplateNotFoundError";
  }
}

export class CommunicationConflictError extends Error {
  constructor(message = "Communication request conflicts with current state") {
    super(message);
    this.name = "CommunicationConflictError";
  }
}

export class CommunicationValidationError extends Error {
  constructor(message = "Communication request is invalid") {
    super(message);
    this.name = "CommunicationValidationError";
  }
}

export class CommunicationUnavailableError extends Error {
  constructor(message = "Communication capability is unavailable") {
    super(message);
    this.name = "CommunicationUnavailableError";
  }
}
