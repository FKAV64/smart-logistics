import React, { useState, useRef } from 'react';
import { useCourierStore } from '../store/useCourierStore';
import { 
  Users, 
  Truck, 
  CheckCircle, 
  Activity, 
  LogOut, 
  User as UserIcon,
  Phone,
  Settings,
  LayoutDashboard,
  Trash2,
  PlusCircle,
  AlertCircle,
  Camera
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import './AdminDashboard.css';

const AdminDashboard = () => {
  const { 
    couriers, 
    stats, 
    logout, 
    user, 
    addCourier, 
    deleteCourier,
    updateProfileImage
  } = useCourierStore();
  
  const [activeTab, setActiveTab] = useState('dashboard');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(null); // stores courier ID
  const fileInputRef = useRef(null);
  
  // New Courier Form State
  const [newName, setNewName] = useState('');
  const [newID, setNewID] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newVehicle, setNewVehicle] = useState('');
  
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const handleAddCourier = (e) => {
    e.preventDefault();
    if (!newName || !newID) return;
    
    addCourier({
      id: newID,
      name: newName,
      phone: newPhone || 'N/A',
      vehicleId: newVehicle || 'unassigned'
    });
    
    // Reset form
    setNewName('');
    setNewID('');
    setNewPhone('');
    setNewVehicle('');
    setActiveTab('couriers'); // Go to list to see new entry
  };

  const confirmDelete = (id) => {
    deleteCourier(id);
    setShowDeleteConfirm(null);
  };

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        updateProfileImage(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  const renderDashboard = () => (
    <>
      <section className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon blue"><Truck size={24} /></div>
          <div className="stat-content">
            <h3>{stats.totalActiveVehicles}</h3>
            <p>Active Vehicles</p>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon green"><CheckCircle size={24} /></div>
          <div className="stat-content">
            <h3>{stats.solvedAlertsToday}</h3>
            <p>Solved Alerts (Today)</p>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon purple"><Activity size={24} /></div>
          <div className="stat-content">
            <h3>{stats.systemPerformance}</h3>
            <p>System Performance</p>
          </div>
        </div>
      </section>

      <section className="courier-section">
        <div className="section-header">
          <h2>Recent Couriers</h2>
          <button className="add-btn" onClick={() => setActiveTab('couriers')}>View Full List</button>
        </div>
        <table className="courier-table">
          <thead>
            <tr><th>Name</th><th>ID Number</th><th>Status</th></tr>
          </thead>
          <tbody>
            {couriers.slice(0, 3).map(d => (
              <tr key={d.id}>
                <td><div className="courier-name"><div className="avatar-small">{d.name.charAt(0)}</div>{d.name}</div></td>
                <td><code>{d.id}</code></td>
                <td><span className="status-badge online">Online</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );

  const renderCouriers = (isSettings = false) => (
    <section className="courier-section">
      <div className="section-header">
        <h2>{isSettings ? 'Manage Couriers' : 'All Couriers'}</h2>
        {isSettings && <span className="helper-text">Add and remove personnel from the system</span>}
      </div>
      <table className="courier-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>ID Number</th>
            <th>Telephone</th>
            <th>Vehicle Driving</th>
            {isSettings && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {couriers.map(d => (
            <tr key={d.id}>
              <td><div className="courier-name"><div className="avatar-small">{d.name.charAt(0)}</div>{d.name}</div></td>
              <td><code>{d.id}</code></td>
              <td><div className="phone-tag"><Phone size={14} />{d.phone}</div></td>
              <td><span className="vehicle-tag">{d.vehicleId}</span></td>
              {isSettings && (
                <td>
                  <button className="delete-btn-icon" onClick={() => setShowDeleteConfirm(d.id)}>
                    <Trash2 size={18} />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );

  const renderSettings = () => (
    <div className="settings-view">
      <section className="add-courier-card">
        <div className="card-header-with-icon">
          <PlusCircle size={24} />
          <h2>Add New Courier</h2>
        </div>
        <form onSubmit={handleAddCourier} className="management-form">
          <div className="form-grid">
            <div className="form-group">
              <label>Full Name</label>
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Ahmet Yılmaz" required />
            </div>
            <div className="form-group">
              <label>Courier ID (Manual)</label>
              <input type="text" value={newID} onChange={(e) => setNewID(e.target.value)} placeholder="e.g. D04" required />
            </div>
            <div className="form-group">
              <label>Phone Number</label>
              <input type="text" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="+90 ..." />
            </div>
            <div className="form-group">
              <label>Assigned Vehicle</label>
              <input type="text" value={newVehicle} onChange={(e) => setNewVehicle(e.target.value)} placeholder="vehicle-X" />
            </div>
          </div>
          <button type="submit" className="submit-btn-admin">Register Courier</button>
        </form>
      </section>

      {renderCouriers(true)}
    </div>
  );

  return (
    <div className="admin-container">
      {/* Sidebar */}
      <nav className="admin-sidebar">
        <div className="admin-brand">
          <Truck size={32} />
          <span>Sivas Logistics</span>
        </div>
        
        <ul className="sidebar-menu">
          <li className={activeTab === 'dashboard' ? 'active' : ''} onClick={() => setActiveTab('dashboard')}>
            <LayoutDashboard size={20} /> Dashboard
          </li>
          <li className={activeTab === 'couriers' ? 'active' : ''} onClick={() => setActiveTab('couriers')}>
            <Users size={20} /> Couriers
          </li>
          <li className={activeTab === 'fleet' ? 'active' : ''} onClick={() => setActiveTab('fleet')}>
            <Truck size={20} /> Fleet Status
          </li>
          <li className={activeTab === 'logs' ? 'active' : ''} onClick={() => setActiveTab('logs')}>
            <Activity size={20} /> System Logs
          </li>
          <li className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}>
            <Settings size={20} /> Settings
          </li>
        </ul>

        <div className="sidebar-footer">
          <button className="admin-logout-btn" onClick={handleLogout}>
            <LogOut size={20} />
            <span>Logout</span>
          </button>
        </div>
      </nav>

      {/* Main Content */}
      <main className="admin-main">
        <header className="admin-header">
          <div className="header-title">
            <h1>{activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}</h1>
            <p>Welcome back, {user?.name}</p>
          </div>
          <div className="admin-profile-section">
            <div className="admin-user-details">
              <span className="admin-user-name">{user?.name}</span>
              <span className="admin-user-role">System Administrator</span>
            </div>
            <div className="admin-avatar-container" onClick={() => fileInputRef.current.click()}>
              {user?.profileImage ? (
                <img src={user.profileImage} alt="Profile" className="admin-profile-img" />
              ) : (
                <UserIcon size={24} />
              )}
              <div className="avatar-overlay">
                <Camera size={14} />
              </div>
            </div>
            <input 
              type="file" 
              ref={fileInputRef} 
              style={{ display: 'none' }} 
              accept="image/*" 
              onChange={handleImageUpload} 
            />
          </div>
        </header>

        {activeTab === 'dashboard' && renderDashboard()}
        {activeTab === 'couriers' && renderCouriers(false)}
        {activeTab === 'settings' && renderSettings()}
        
        {(activeTab === 'fleet' || activeTab === 'logs') && (
           <div className="placeholder-view">
             <Activity size={48} />
             <h2>{activeTab === 'fleet' ? 'Fleet Status Monitoring' : 'System Logs'}</h2>
             <p>This module is currently being optimized for Sivas regional operations.</p>
           </div>
        )}
      </main>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="modal-overlay">
          <div className="confirm-modal">
            <AlertCircle size={40} color="#ef4444" />
            <h2>Remove Courier?</h2>
            <p>Are you sure you want to remove courier ID: <strong>{showDeleteConfirm}</strong> from the system? This action cannot be undone.</p>
            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => setShowDeleteConfirm(null)}>Cancel</button>
              <button className="btn-confirm-delete" onClick={() => confirmDelete(showDeleteConfirm)}>Yes, Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminDashboard;
