import { getAgentConfig, type AgentConfig } from './agents.js';

export interface TemplateVars {
  config_dir: string;
  skills_dir: string;
  home_skills_dir: string;
  settings_file: string;
  agent_name: string;
  skills_cli_agent_flag: string;
}

export function buildTemplateVars(agent: AgentConfig & { homeSkillsDir?: string }): TemplateVars {
  return {
    config_dir: agent.configDir,
    skills_dir: agent.skillsDir,
    home_skills_dir: `~/${['.codex/skills', '.agents/skills'].includes(agent.skillsDir)
      ? agent.skillsDir : agent.homeSkillsDir ?? getAgentConfig(agent.id).skillsDir}`,
    settings_file: agent.settingsFile ?? '',
    agent_name: agent.displayName,
    skills_cli_agent_flag: agent.skillsCliAgent ? `--agent ${agent.skillsCliAgent}` : '',
  };
}

export function processTemplate(content: string, vars: TemplateVars): string {
  return content.replaceAll('~/{{skills_dir}}', vars.home_skills_dir).replace(/\{\{(config_dir|skills_dir|home_skills_dir|settings_file|agent_name|skills_cli_agent_flag)\}\}/g, (_, key: string) => {
    return vars[key as keyof TemplateVars];
  });
}
