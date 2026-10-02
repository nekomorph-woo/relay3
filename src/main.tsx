import { installExceptionReporting, reportException } from './diagnostics';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
installExceptionReporting();
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    reportException('renderer.react-error', error);
  }
  render() {
    return this.state.failed ? (
      <main style={{ padding: 32 }}>
        <h2>页面遇到异常</h2>
        <p>异常已记录，请重新打开应用后导出诊断日志。</p>
        <button onClick={() => location.reload()}>重新加载</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
