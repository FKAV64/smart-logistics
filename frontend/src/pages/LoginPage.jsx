import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCourierStore } from '../store/useCourierStore';
import { Lock, User, Truck, ShieldAlert } from 'lucide-react';
import './LoginPage.css';

const LoginPage = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const login = useCourierStore((state) => state.login);
  const navigate = useNavigate();

  const handleSubmit = (e) => {
    e.preventDefault();
    const result = login(username, password);
    if (result.success) {
      if (result.role === 'admin') {
        navigate('/admin');
      } else {
        navigate('/courier');
      }
    } else {
      setError(result.message);
    }
  };

  return (
    <div className="login-page">
      <div className="login-background">
        <div className="shape circle-1"></div>
        <div className="shape circle-2"></div>
        <div className="shape circle-3"></div>
      </div>
      
      <div className="glass-login-card">
        <div className="login-header">
          <div className="login-logo">
            <Truck size={40} className="logo-icon" />
          </div>
          <h2>Smart Logistics</h2>
          <p>Courier & Admin Portal</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="input-group">
            <User size={18} className="input-icon" />
            <input 
              type="text" 
              placeholder="Username" 
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>

          <div className="input-group">
            <Lock size={18} className="input-icon" />
            <input 
              type="password" 
              placeholder="Password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && (
            <div className="login-error">
              <ShieldAlert size={16} />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="login-btn">
            Sign In
          </button>
        </form>

        <div className="login-footer">
          <p>© 2026 Sivas Smart Logistics Solutions</p>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
