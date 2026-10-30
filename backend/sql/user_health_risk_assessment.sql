-- 用户健康风险测评记录表（供 Text2SQL 智能问数模块使用）
CREATE TABLE IF NOT EXISTS user_health_risk_assessment (
    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
    user_id VARCHAR(64) NOT NULL COMMENT '用户唯一标识',
    user_name VARCHAR(100) NOT NULL COMMENT '用户姓名',
    sex ENUM('男', '女', '其他') NOT NULL COMMENT '性别',
    age TINYINT UNSIGNED NOT NULL COMMENT '年龄',
    assessment_time DATETIME NOT NULL COMMENT '测评时间',
    assessment_count INT DEFAULT 1 COMMENT '测试次数',
    total_score TINYINT UNSIGNED NOT NULL COMMENT '总分',
    nutritional_impairment_score TINYINT UNSIGNED NOT NULL COMMENT '营养受损分',
    disease_severity_score TINYINT UNSIGNED NOT NULL COMMENT '疾病严重度分',
    age_score TINYINT UNSIGNED NOT NULL COMMENT '年龄分',
    assessment_basis TEXT COMMENT '评分依据说明',
    risk_level ENUM('无风险', '低风险', '中风险', '高风险') NOT NULL COMMENT '风险等级',
    bmi DECIMAL(4,2) COMMENT 'BMI指数',
    weight_change VARCHAR(100) COMMENT '体重变化情况',
    disease_condition TEXT COMMENT '疾病状况描述',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
    INDEX idx_health_risk_user (user_id),
    INDEX idx_health_risk_level (risk_level),
    INDEX idx_health_risk_time (assessment_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户健康风险测评记录表';
