import {DataTypes} from 'sequelize';
import {sequelize} from '../index.js';

export const Tenant = sequelize.define('tenants', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    api_key_hash: {
        type: DataTypes.STRING,
        allowNull: false
    },
    api_key_prefix: {
        type: DataTypes.STRING
    },
    api_key_plain: {
        type: DataTypes.STRING
    },
    username: {
        type: DataTypes.STRING
    },
    password_hash: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    password_salt: {
        type: DataTypes.STRING(64),
        allowNull: true
    },
    role: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'user'
    }
}, {
    indexes: [
        {
            unique: true,
            fields: ['api_key_hash']
        },
        {
            unique: true,
            fields: ['username']
        }
    ]
});
