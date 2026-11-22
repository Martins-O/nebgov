const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export function requireJwtSecret(): string {
  return required("JWT_SECRET");
}

export function validateConfig(): void {
  requireJwtSecret();
}
