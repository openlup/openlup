- Keep the Node host's local HTTP listener available until admitted scheduler
  callbacks finish, including callbacks waiting for advisory-lock acquisition
  before calling their HTTP compatibility endpoint. Shutdown still attempts
  listener and lock-session cleanup when draining fails.
