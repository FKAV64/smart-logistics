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
  
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  
  if (requiredRole && user.role !== requiredRole) {
    return <Navigate to={user.role === 'admin' ? '/admin' : '/courier'} replace />;
  }
  
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
