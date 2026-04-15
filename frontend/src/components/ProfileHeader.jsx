import React, { useRef } from 'react';
import { useCourierStore } from '../store/useCourierStore';
import { Camera, User as UserIcon } from 'lucide-react';
import './ProfileHeader.css';

const ProfileHeader = () => {
  const { user, updateProfileImage } = useCourierStore();
  const fileInputRef = useRef(null);

  const handleImageClick = () => {
    fileInputRef.current.click();
  };

  const handleFileChange = (event) => {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        updateProfileImage(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="profile-header">
      <div className="profile-image-container" onClick={handleImageClick}>
        {user?.profileImage ? (
          <img src={user.profileImage} alt="Profile" className="profile-image" />
        ) : (
          <div className="profile-image-placeholder">
            <UserIcon size={32} />
          </div>
        )}
        <div className="profile-image-overlay">
          <Camera size={16} />
        </div>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="image/*"
          style={{ display: 'none' }}
        />
      </div>
      <div className="profile-info">
        <span className="welcome-text">Welcome back,</span>
        <h2 className="user-name">{user?.name || 'Courier'}</h2>
      </div>
    </div>
  );
};

export default ProfileHeader;
