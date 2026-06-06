import {DataTypes} from 'sequelize';
import {sequelize} from '../index.js';

export const AiAssessment = sequelize.define('ai_assessments', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    tenant_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    username: {
        type: DataTypes.STRING
    },
    period: {
        type: DataTypes.STRING,
        allowNull: false
    },
    sample_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    overall_score: {
        type: DataTypes.INTEGER
    },
    summary: {
        type: DataTypes.TEXT
    },
    strengths: {
        type: DataTypes.TEXT,
        get() {
            const raw = this.getDataValue('strengths');
            if (!raw) return [];
            try { return JSON.parse(raw); } catch { return []; }
        },
        set(val) {
            this.setDataValue('strengths', JSON.stringify(val || []));
        }
    },
    improvements: {
        type: DataTypes.TEXT,
        get() {
            const raw = this.getDataValue('improvements');
            if (!raw) return [];
            try { return JSON.parse(raw); } catch { return []; }
        },
        set(val) {
            this.setDataValue('improvements', JSON.stringify(val || []));
        }
    },
    recommendations: {
        type: DataTypes.TEXT,
        get() {
            const raw = this.getDataValue('recommendations');
            if (!raw) return [];
            try { return JSON.parse(raw); } catch { return []; }
        },
        set(val) {
            this.setDataValue('recommendations', JSON.stringify(val || []));
        }
    },
    skill_scores: {
        type: DataTypes.TEXT,
        get() {
            const raw = this.getDataValue('skill_scores');
            if (!raw) return {};
            try { return JSON.parse(raw); } catch { return {}; }
        },
        set(val) {
            this.setDataValue('skill_scores', JSON.stringify(val || {}));
        }
    },
    raw_analysis: {
        type: DataTypes.TEXT('long')
    },
    triggered_by: {
        type: DataTypes.STRING
    },
    status: {
        type: DataTypes.STRING,
        defaultValue: 'completed'
    }
}, {
    indexes: [
        {fields: ['tenant_id', 'period']},
        {fields: ['period']}
    ]
});