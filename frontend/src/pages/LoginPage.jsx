import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCourierStore } from '../store/useCourierStore';
import { Lock, User, Truck, ShieldAlert } from 'lucide-react';
import './LoginPage.css';

const LoginPage = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const login = useCourierStore((state) => state.login);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    const result = await login(email, password);
    if (result.success) {
      navigate('/courier');
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
          <p>Courier Portal</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="input-group">
            <User size={18} className="input-icon" />
            <input 
              type="text" 
              placeholder="Email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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
