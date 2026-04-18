import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useCourierStore } from './store/useCourierStore';
import LoginPage from './pages/LoginPage';
import CourierDashboard from './pages/CourierDashboard';
import AdminDashboard from './pages/AdminDashboard';
import './App.css';

// Protected Route Component to guard dashboards
const ProtectedRoute = ({ children, requiredRole }) => {
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

  // 3. Role Validation
  if (requiredRole && user.role !== requiredRole) {
    console.warn(`Role mismatch: Expected ${requiredRole}, got ${user.role}`);

    // Explicit routing to avoid infinite loops
    if (user.role === 'admin') {
      return <Navigate to="/admin" replace />;
    } else if (user.role === 'courier') {
      return <Navigate to="/courier" replace />;
    } else {
      // If the role is missing or completely unrecognized, boot them to login
      return <Navigate to="/login" replace />;
    }
  }

  // 4. If all checks pass, render the component
  return children;
};

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/courier"
        element={
          <ProtectedRoute requiredRole="courier">
            <CourierDashboard />
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin"
        element={
          <ProtectedRoute requiredRole="admin">
            <AdminDashboard />
          </ProtectedRoute>
        }
      />

      {/* Default redirect to login for any unknown paths or root */}
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default App;