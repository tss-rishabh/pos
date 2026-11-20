import { Component, type ReactNode } from 'react';
import { reportUiError } from '../observability/report-ui-error';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  /** ID-only report (event, error class name, route pattern): never the message, stack,
   * component stack or props. */
  override componentDidCatch(error: unknown) {
    reportUiError('ui.render.failed', error);
  }
  override render() {
    return this.state.failed ? (
      <div className="empty" role="alert">
        <h2>Your workspace was interrupted.</h2>
        <p>Your saved carts remain on this device.</p>
        <button className="button secondary" onClick={() => window.location.reload()}>
          Reload workspace
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
