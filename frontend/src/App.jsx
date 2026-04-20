import React, { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useCourierStore } from './store/useCourierStore';
import LoginPage from './pages/LoginPage';
import CourierDashboard from './pages/CourierDashboard';
import ErrorBoundary from './components/ErrorBoundary';
import './App.css';

// Protected Route Component to guard dashboards
const ProtectedRoute = ({ children }) => {
  const { isAuthenticated, user } = useCourierStore();

  // 1. Check if the user is authenticated at all
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // 2. Safety Check: Ensure user object exists before checking properties
  if (!user) {
    console.warn("User object is missing, returning to login.");
    return <Navigate to="/login" replace />;
  }


  return children;
};

function App() {
  const initFromStorage = useCourierStore((s) => s.initFromStorage);
  useEffect(() => { initFromStorage(); }, []);

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

      <Route
        path="/courier"
        element={
          <ProtectedRoute>
            <CourierDashboard />
          </ProtectedRoute>
        }
      />



      {/* Default redirect to login for any unknown paths or root */}
      <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}

export default App;