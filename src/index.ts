import buildApplication, {
  BaseApplicationConfig,
  StateMachine,
  Application
} from 'lotion-state-machine'

import { join } from 'path'
import { homedir } from 'os'
import createABCIServer, { ABCIServer } from './abci-server'
import createTendermintProcess from './tendermint'
import createDiscoveryServer, { DiscoveryServer } from './discovery'
import { randomBytes, createHash } from 'crypto'
import fs = require('fs-extra')
import getPort = require('get-port')
import DJSON = require('deterministic-json')
import level = require('level')
import merk = require('merk')

interface ApplicationConfig extends BaseApplicationConfig {
  rpcPort?: number
  p2pPort?: number
  abciPort?: number
  logTendermint?: boolean
  keyPath?: string
  genesisPath?: string
  lotionHome?: string
  peers?: Array<string>
  discovery?: boolean
  disableTendermint?: boolean
}

interface PortMap {
  abci: number
  p2p: number
  rpc: number
}

interface AppInfo {
  ports: PortMap
  GCI: string
  genesisPath: string
  home: string
}

class LotionApp implements Application {
  private db: any
  private state: any
  private stateMachine: StateMachine
  private application: Application
  private abciServer: ABCIServer
  private discoveryServer: DiscoveryServer
  private tendermintProcess
  private ports: PortMap
  private genesis: string
  private peers: Array<string>
  private genesisPath: string
  private keyPath: string
  private initialState: object
  private logTendermint: boolean
  private disableTendermint: boolean = false
  private discovery: boolean = true
  private home: string
  private lotionHome: string = join(homedir(), '.lotion', 'networks')

  public use
  public useTx
  public useBlock
  public useInitializer
  public GCI

  constructor(private config: ApplicationConfig) {
    this.application = buildApplication(config)
    this.logTendermint = config.logTendermint
    this.initialState = config.initialState
    this.keyPath = config.keyPath
    this.genesisPath = config.genesisPath
    this.peers = config.peers
    this.discovery = config.discovery == null ? true : config.discovery
    this.disableTendermint = config.disableTendermint == null ? false : config.disableTendermint

    this.setHome()

    if (this.disableTendermint) {
        console.log("Running in TM disabled mode")

        if (this.genesisPath == null || this.lotionHome == null) {
            throw "genesisPath OR lotionHome is null, both fields needed"
        }

        this.home = config.lotionHome
        this.lotionHome = this.home
    }

    Object.assign(this, this.application)
  }

  private async assignPorts() {
    this.ports = {
      abci: this.config.abciPort || (await getPort()),
      p2p: this.config.p2pPort || (await getPort()),
      rpc: this.config.rpcPort || (await getPort())
    }
  }

  private setGCI() {
    this.GCI = createHash('sha256')
      .update(this.genesis)
      .digest('hex')
  }

  private getAppInfo(): AppInfo {
    return {
      ports: this.ports,
      GCI: this.GCI,
      genesisPath: this.genesisPath,
      home: this.home
    }
  }

  private setGenesis() {
    if (!this.genesisPath) {
      this.genesisPath = join(this.home, 'config', 'genesis.json')
    }

    let genesisJSON = fs.readFileSync(this.genesisPath, 'utf8')
    let parsedGenesis = JSON.parse(genesisJSON)
    this.genesis = DJSON.stringify(parsedGenesis)
  }

  private setHome() {
    /**
     * if genesis and key paths are provided,
     * home path is hash(genesisPath + keyPath)
     *
     * otherwise a random id is generated.
     */
    if (this.config.genesisPath && this.config.keyPath) {
      this.home = join(
        this.lotionHome,
        createHash('sha256')
          .update(fs.readFileSync(this.config.genesisPath))
          .update(fs.readFileSync(this.config.keyPath))
          .digest('hex')
      )
    } else if (this.config.genesisPath && !this.config.keyPath) {
      this.home = join(
        this.lotionHome,
        createHash('sha256')
          .update(fs.readFileSync(this.config.genesisPath))
          .digest('hex')
      )
    } else {
      this.home = join(this.lotionHome, randomBytes(16).toString('hex'))
    }
  }

  async start() {
    await this.assignPorts()
    await fs.mkdirp(this.home)

    // create or load state db
    this.db = level(join(this.home, 'state.db'))
    this.state = await merk(this.db)

    // start state machine
    this.stateMachine = this.application.compile(this.state)

    this.abciServer = createABCIServer(
      this.state,
      this.stateMachine,
      this.initialState,
      this.home
    )
    this.abciServer.listen(this.ports.abci, '0.0.0.0')


    let tm = {
      ports: this.ports,
      home: this.home,
      logTendermint: this.logTendermint,
      keyPath: this.keyPath,
      genesisPath: this.genesisPath,
      peers: this.peers
    }

    if (this.disableTendermint) {
        // do not start tendermint
        this.tendermintProcess = tm

        console.log("Please start your Tendermint nodes with the following options")
        console.log(`--rpc.laddr=tcp://0.0.0.0:${this.ports.rpc}`)
        console.log(`--p2p.laddr=tcp://0.0.0.0:${this.ports.p2p}`)
        console.log(`--proxy_app=tcp://0.0.0.0:${this.ports.abci}`)
        console.log(`--home=${this.home}`)
    } else {
        // start tendermint process
        this.tendermintProcess = await createTendermintProcess(tm)
    }

    this.setGenesis()
    this.setGCI()

    console.log("Ports", this.ports)
    console.log("Home", this.home)
    console.log("LotionHome: ", this.lotionHome)
    console.log("GenesisPath", this.genesisPath)
    console.log("LogTendermint", this.logTendermint)
    console.log("KeyPath", this.keyPath)
    console.log("Peers", this.peers)
    console.log("GCI", this.GCI)

    // start discovery server
    this.discoveryServer = createDiscoveryServer({
      GCI: this.GCI,
      rpcPort: this.ports.rpc
    })

    let appInfo = this.getAppInfo()

    return appInfo
  }
}

let Lotion: any = function(config) {
  return new LotionApp(config)
}

Lotion.connect = require('lotion-connect')
export = Lotion
