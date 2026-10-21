import { Component, type ErrorInfo, type ReactNode } from 'react';
import '../components/states/states.css';

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Contains render crashes to a recoverable panel instead of a blank page.
 * (React only supports error boundaries as class components.)
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Lionscope dashboard crashed', error, info.componentStack);
  }

  private readonly retry = () => this.setState({ error: null });

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <div className="empty-state" data-tone="critical" role="alert">
          <p className="overline">Dashboard</p>
          <h1 className="empty-title">Something broke while drawing the dashboard</h1>
          <p className="empty-error mono">{error.message || String(error)}</p>
          <p>Recording continues on the server. Try again, or reload to reconnect from scratch.</p>
          <div className="crash-actions">
            <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button type="button" className="btn" onClick={this.retry}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
