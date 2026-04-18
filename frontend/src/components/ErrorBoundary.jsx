import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ 
          height: '100vh', 
          display: 'flex', 
          flexDirection: 'column', 
          justifyContent: 'center', 
          alignItems: 'center', 
          background: '#0f172a', 
          color: '#f8fafc',
          fontFamily: 'system-ui'
        }}>
          <h2 style={{ marginBottom: '1rem', color: '#ef4444' }}>Critical Subsystem Failure</h2>
          <p style={{ marginBottom: '2rem', opacity: 0.8 }}>The application encountered an unexpected runtime error.</p>
          <button 
            onClick={() => window.location.href = '/'} 
            style={{ 
              padding: '10px 20px', 
              background: '#3b82f6', 
              color: 'white', 
              border: 'none', 
              borderRadius: '6px', 
              cursor: 'pointer',
              fontWeight: '500'
            }}
          >
            Restart Application
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
