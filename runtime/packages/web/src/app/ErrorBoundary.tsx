import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryFallbackProps {
  error: Error;
  reset: () => void;
  /** React component stack of the failure, when React supplied one. */
  componentStack?: string | undefined;
}

export interface ErrorBoundaryProps {
  /** The boundary leaves its fallback when any of these changes (shallow, Object.is). */
  resetKeys: readonly unknown[];
  fallback: (props: ErrorBoundaryFallbackProps) => ReactNode;
  children?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | undefined;
}

function changed(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]));
}

/** The one error boundary class of the app (04-ui.md 3.4); no react-error-boundary dependency. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, componentStack: undefined };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? undefined });
    // Only name and message reach the console, never data values (04-ui.md 3.4).
    // eslint-disable-next-line no-console -- the design logs a caught render error with console.error and nowhere else (04-ui.md 3.4)
    console.error(`UI error: ${error.name}: ${error.message}`);
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error !== null && changed(previous.resetKeys, this.props.resetKeys)) this.reset();
  }

  reset = (): void => {
    this.setState({ error: null, componentStack: undefined });
  };

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (error === null) return this.props.children;
    return this.props.fallback({ error, reset: this.reset, componentStack });
  }
}
