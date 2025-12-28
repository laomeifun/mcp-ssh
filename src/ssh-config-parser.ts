import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import * as sshConfig from 'ssh-config';
import { SSHHostInfo } from './types.js';

export class SSHConfigParser {
  private configPath: string;
  private knownHostsPath: string;

  constructor(configPath?: string) {
    const homeDir = homedir();
    this.configPath = configPath || join(homeDir, '.ssh', 'config');
    this.knownHostsPath = join(homeDir, '.ssh', 'known_hosts');
  }

  /**
   * Reads and parses the SSH config file
   */
  async parseConfig(): Promise<SSHHostInfo[]> {
    try {
      const content = await readFile(this.configPath, 'utf-8');
      const config = sshConfig.parse(content);
      return this.extractHostsFromConfig(config);
    } catch (error) {
      console.error('Error reading SSH config:', error);
      return [];
    }
  }

  /**
   * Extracts host information from SSH Config
   */
  private extractHostsFromConfig(config: any[]): SSHHostInfo[] {
    const hosts: SSHHostInfo[] = [];

    for (const section of config) {
      if (section.param === 'Host' && section.value !== '*') {
        const hostInfo: SSHHostInfo = {
          hostname: '',
          alias: section.value,
        };

        // Search all entries for this host
        for (const param of section.config) {
          switch (param.param.toLowerCase()) {
            case 'hostname':
              hostInfo.hostname = param.value;
              break;
            case 'user':
              hostInfo.user = param.value;
              break;
            case 'port':
              hostInfo.port = parseInt(param.value, 10);
              break;
            case 'identityfile':
              hostInfo.identityFile = param.value;
              break;
            default:
              // Store other parameters
              hostInfo[param.param.toLowerCase()] = param.value;
          }
        }

        // Only add hosts with complete information
        if (hostInfo.hostname) {
          hosts.push(hostInfo);
        }
      }
    }

    return hosts;
  }

  /**
   * Reads the known_hosts file and extracts hostnames
   */
  async parseKnownHosts(): Promise<string[]> {
    try {
      const content = await readFile(this.knownHostsPath, 'utf-8');
      const knownHosts = content
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => {
          // Format: hostname[,hostname2...] key-type public-key
          const parts = line.split(' ')[0];
          return parts.split(',')[0];
        });

      return knownHosts;
    } catch (error) {
      console.error('Error reading known_hosts file:', error);
      return [];
    }
  }

  /**
   * Consolidates information from config and known_hosts
   */
  async getAllKnownHosts(): Promise<SSHHostInfo[]> {
    const configHosts = await this.parseConfig();
    const knownHostnames = await this.parseKnownHosts();

    // Add hosts from known_hosts that aren't in the config
    for (const hostname of knownHostnames) {
      if (!configHosts.some(host => 
          host.hostname === hostname || 
          host.alias === hostname)) {
        configHosts.push({
          hostname: hostname
        });
      }
    }

    return configHosts;
  }
}
