import { NodeSSH } from 'node-ssh';
import { SSHHostInfo, CommandResult, ConnectionStatus, BatchCommandResult } from './types.js';
import { SSHConfigParser } from './ssh-config-parser.js';

export class SSHClient {
  private ssh: NodeSSH;
  private configParser: SSHConfigParser;

  constructor(options: { configPath?: string } = {}) {
    this.ssh = new NodeSSH();
    this.configParser = new SSHConfigParser(options.configPath);
  }

  /**
   * Lists all known SSH hosts
   */
  async listKnownHosts(): Promise<SSHHostInfo[]> {
    return await this.configParser.getAllKnownHosts();
  }

  /**
   * Connects to an SSH host and executes a command
   */
  async runRemoteCommand(hostAlias: string, command: string): Promise<CommandResult> {
    try {
      // First connect to the host
      await this.connectToHost(hostAlias);

      // Execute the command
      const result = await this.ssh.execCommand(command);
      
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code || 0
      };
    } catch (error) {
      console.error(`Error executing command on ${hostAlias}:`, error);
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        code: 1
      };
    } finally {
      this.ssh.dispose();
    }
  }

  /**
   * Returns all details about a host
   */
  async getHostInfo(hostAlias: string): Promise<SSHHostInfo | null> {
    const hosts = await this.configParser.parseConfig();
    return hosts.find(host => host.alias === hostAlias || host.hostname === hostAlias) || null;
  }

  /**
   * Checks if a connection to the host is possible
   */
  async checkConnectivity(hostAlias: string): Promise<ConnectionStatus> {
    try {
      // Establish connection
      await this.connectToHost(hostAlias);
      
      // Execute ping command
      const result = await this.ssh.execCommand('echo connected');
      
      const connected = result.stdout.trim() === 'connected';
      
      this.ssh.dispose();
      
      return {
        connected,
        message: connected ? 'Connection successful' : 'Echo test failed'
      };
    } catch (error) {
      console.error(`Connectivity error with ${hostAlias}:`, error);
      return {
        connected: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Uploads a file to the remote host
   */
  async uploadFile(hostAlias: string, localPath: string, remotePath: string): Promise<boolean> {
    try {
      await this.connectToHost(hostAlias);
      
      await this.ssh.putFile(localPath, remotePath);
      
      this.ssh.dispose();
      return true;
    } catch (error) {
      console.error(`Error uploading file to ${hostAlias}:`, error);
      return false;
    }
  }

  /**
   * Downloads a file from the remote host
   */
  async downloadFile(hostAlias: string, remotePath: string, localPath: string): Promise<boolean> {
    try {
      await this.connectToHost(hostAlias);
      
      await this.ssh.getFile(localPath, remotePath);
      
      this.ssh.dispose();
      return true;
    } catch (error) {
      console.error(`Error downloading file from ${hostAlias}:`, error);
      return false;
    }
  }

  /**
   * Executes multiple commands in sequence
   */
  async runCommandBatch(hostAlias: string, commands: string[]): Promise<BatchCommandResult> {
    try {
      await this.connectToHost(hostAlias);
      
      const results: CommandResult[] = [];
      let success = true;
      
      for (const command of commands) {
        const result = await this.ssh.execCommand(command);
        const cmdResult: CommandResult = {
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.code || 0
        };
        
        results.push(cmdResult);
        
        if (cmdResult.code !== 0) {
          success = false;
          // We don't abort, execute all commands
        }
      }
      
      this.ssh.dispose();
      return {
        results,
        success
      };
    } catch (error) {
      console.error(`Error during batch execution on ${hostAlias}:`, error);
      return {
        results: [{
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          code: 1
        }],
        success: false
      };
    }
  }

  /**
   * Establishes a connection to a host
   */
  private async connectToHost(hostAlias: string): Promise<void> {
    // Get host information
    const hostInfo = await this.getHostInfo(hostAlias);
    
    if (!hostInfo) {
      throw new Error(`Host ${hostAlias} not found`);
    }

    // Create connection configuration
    const connectionConfig = {
      host: hostInfo.hostname,
      username: hostInfo.user,
      port: hostInfo.port || 22,
      privateKeyPath: hostInfo.identityFile
    };

    try {
      await this.ssh.connect(connectionConfig);
    } catch (error) {
      throw new Error(`Connection to ${hostAlias} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
