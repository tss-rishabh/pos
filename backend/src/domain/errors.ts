export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
export const unavailable = (name: string): never => {
  throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', `${name} is not configured or unavailable.`);
};
