/**
 * Error Boundary – catches React component errors and shows a fallback UI.
 * Prevents the entire app from crashing when a page throws.
 */

import React, { Component, ErrorInfo, ReactNode } from "react";
import { Result, Button } from "antd";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const isProd = import.meta.env.PROD;
      const message = isProd
        ? "An unexpected error occurred."
        : (this.state.error?.message ?? "An unexpected error occurred.");
      return (
        this.props.fallback ?? (
          <div role="alert" aria-live="assertive">
            <Result
              status="error"
              title="Something went wrong"
              subTitle={message}
              extra={
                <Button
                  type="primary"
                  aria-label="Retry loading this section"
                  onClick={() => this.setState({ hasError: false, error: null })}
                >
                  Try Again
                </Button>
              }
            />
          </div>
        )
      );
    }
    return this.props.children;
  }
}
