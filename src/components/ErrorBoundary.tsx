import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  label?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? ":" + this.props.label : ""}]`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            padding: 40,
            height: "100%",
            textAlign: "center",
          }}
        >
          <AlertTriangle size={28} color="var(--coral)" />
          <div style={{ fontWeight: 600 }}>Что-то пошло не так на этой странице</div>
          <div className="muted-sm" style={{ maxWidth: 480, wordBreak: "break-word" }}>
            {this.state.error.message}
          </div>
          <button type="button" className="btn" onClick={this.reset}>
            Попробовать снова
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
