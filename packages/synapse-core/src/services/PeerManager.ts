import Wire from '@firaenix/bittorrent-protocol';
import Bitfield from 'bitfield';
import { TypedEmitter } from 'tiny-typed-emitter';
import { inject, injectable, injectAll } from 'tsyringe';
import { v4 as uuid } from 'uuid';

import { InjectedExtension } from '../models/InjectedExtensions';
import { SupportedHashAlgorithms } from '../models/SupportedHashAlgorithms';
import { IHashService } from './HashService';
import { ILogger } from './interfaces/ILogger';
import { IPeerStrategy } from './interfaces/IPeerStrategy';
import { MetaInfoService } from './MetaInfoService';
import { Peer, PeerEvents } from './Peer';
import { PieceManager } from './PieceManager';

export enum PeerManagerEvents {
  got_piece = 'on:piece',
  got_bitfield = 'on:bitfield',
  got_request = 'on:request'
}

interface PeerEmitter {
  [PeerManagerEvents.got_piece]: (index: number, offset: number, pieceBuf: Buffer) => void;
  [PeerManagerEvents.got_bitfield]: (peer: Peer, recievedBitfield: Bitfield) => void;
  [PeerManagerEvents.got_request]: (peer: Peer, index: number, offset: number, length: number) => void;
}

@injectable()
export class PeerManager extends TypedEmitter<PeerEmitter> {
  private peerUUID: Buffer;
  private readonly peers: Array<Peer> = [];
  private _peerId?: Buffer | undefined;

  constructor(
    @inject('IHashService')
    private readonly hashService: IHashService,

    @injectAll('IPeerStrategy')
    private readonly peerDiscoveryStrategies: Array<IPeerStrategy>,
    @inject(MetaInfoService)
    private readonly metainfoService: MetaInfoService,
    private readonly pieceManager: PieceManager,

    @injectAll('IExtension')
    private readonly extensions: InjectedExtension[],
    @inject('ILogger') private readonly logger: ILogger
  ) {
    super();
    this.peerUUID = Buffer.from(uuid());

    this.logger.log('PEER MANAGER PEERID', this.peerUUID);

    this.logger.log(
      'Peer discovery strats:',
      peerDiscoveryStrategies.map((x) => x.name)
    );

    if (!peerDiscoveryStrategies || !peerDiscoveryStrategies.length) {
      throw new Error('No IPeerStrategy instances registered, unable to continue.');
    }

    for (const strategy of peerDiscoveryStrategies) {
      strategy.on('found', this.onWireConnected);
      strategy.on('got_update', (key) => {
        // this.logger.info(strategy.name, 'Updated', key);
      });
    }
  }

  public searchByInfoIdentifier = async (infoIdentifier: Buffer) => {
    const infoHashHash = await this.hashService.hash(infoIdentifier, SupportedHashAlgorithms.sha256);

    for (const strategy of this.peerDiscoveryStrategies) {
      strategy.startDiscovery(infoHashHash);
    }
  };

  public stopDiscovery = async (infoIdentifier: Buffer) => {
    const infoHashHash = await this.hashService.hash(infoIdentifier, SupportedHashAlgorithms.sha256);

    await Promise.all(this.peerDiscoveryStrategies.map((x) => x.stopDiscovery(infoHashHash)));
  };

  /**
   * Broadcasts to all peers that we are no longer interested in downloading.
   */
  public setUninterested = () => {
    for (const peer of this.peers) {
      peer.setUninterested();
    }
  };

  public have = (index: number) => {
    for (const peer of this.peers) {
      peer.have(index);
    }
  };

  public cancel = (index: number, offset: number, length: number) => {
    for (const peer of this.peers) {
      peer.cancel(index, offset, length);
    }
  };

  public broadcastBitfield = (bitfield: Bitfield) => {
    for (const peer of this.peers) {
      peer.sendBitfield(bitfield);
    }
  };

  public getPeerThatHasPiece = (pieceIndex: number) => {
    for (const peer of this.peers) {
      if (!peer.bitfield?.get(pieceIndex)) {
        continue;
      }

      return peer;
    }
    return undefined;
  };

  public requestPieceAsync = async (index: number, offset: number, length: number) => {
    // Smartly find a peer that does have the piece we need
    this.logger.warn('NEED TO FIND SMARTER WAY OF REQUESTING PIECES!');
    const peer = this.peers.find((x) => x.bitfield?.get(index) !== undefined);

    if (!peer) {
      throw new Error("Can't find a peer with that piece");
    }

    await peer.request(index, offset, length);
  };

  private onWireConnected = async (connectedWire: Wire, infoIdentifier: Buffer) => {
    for (const extension of this.extensions) {
      connectedWire.use((w) => extension(w, infoIdentifier, this.metainfoService.metainfo));
    }

    const peerId = await this.getPeerId();
    const peer = new Peer(connectedWire, infoIdentifier, peerId, this.logger);

    this.addPeer(peer);
  };

  public addPeer = (peer: Peer) => {
    peer.on(PeerEvents.got_piece, this.onPiece);
    peer.on(PeerEvents.got_bitfield, this.onBitfield(peer));
    peer.on(PeerEvents.got_request, this.onRequest(peer));

    peer.on(PeerEvents.need_bitfield, (cb: (bitfield: Bitfield) => void) => {
      cb(this.pieceManager.getBitfield());
    });

    const peerIndex = this.peers.push(peer);

    peer.on(PeerEvents.close, () => {
      this.peers.splice(peerIndex, 1);
    });
  };

  private onPiece = async (index: number, offset: number, pieceBuf: Buffer) => {
    this.emit(PeerManagerEvents.got_piece, index, offset, pieceBuf);
  };

  private onBitfield = (peer: Peer) => (recievedBitfield: Bitfield) => {
    this.emit(PeerManagerEvents.got_bitfield, peer, recievedBitfield);
  };

  private onRequest = (peer: Peer) => (index: number, offset: number, length: number) => {
    this.logger.log('PeerManager on request', index, offset, length);
    this.emit(PeerManagerEvents.got_request, peer, index, offset, length);
  };

  private async getPeerId(): Promise<Buffer> {
    if (this._peerId) {
      return this._peerId;
    }

    const peerUUIDSha1 = await this.hashService.hash(this.peerUUID, SupportedHashAlgorithms.sha1);
    this._peerId = peerUUIDSha1;
    return this._peerId;
  }
}
