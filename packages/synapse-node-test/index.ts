import '@firaenix/synapse-core/src/typings';
import 'reflect-metadata';

import { Client } from '@firaenix/synapse-core/src/Client';
import { SignedMetainfoFile } from '@firaenix/synapse-core/src/models/MetainfoFile';
import { SupportedHashAlgorithms } from '@firaenix/synapse-core/src/models/SupportedHashAlgorithms';
import { SHA1HashAlgorithm } from '@firaenix/synapse-core/src/services/hashalgorithms/SHA1HashAlgorithm';
import { SHA256HashAlgorithm } from '@firaenix/synapse-core/src/services/hashalgorithms/SHA256HashAlgorithm';
import { HashService } from '@firaenix/synapse-core/src/services/HashService';
import { ConsoleLogger } from '@firaenix/synapse-core/src/services/LogLevelLogger';
import {
  SECP256K1SignatureAlgorithm,
} from '@firaenix/synapse-core/src/services/signaturealgorithms/SECP256K1SignatureAlgorithm';
import { SigningService } from '@firaenix/synapse-core/src/services/SigningService';
import { StreamDownloadService } from '@firaenix/synapse-core/src/services/StreamDownloadService';
import { CreateFilesFromPaths } from '@firaenix/synapse-core/src/utils/CreateFilesFromPaths';
import recursiveReadDir from '@firaenix/synapse-core/src/utils/recursiveReadDir';
import { DHTService, ED25519KeyPair, ED25519SuperCopAlgorithm } from '@firaenix/synapse-dht';
import bencode from 'bencode';
import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';

import { ED25519AlgorithmName } from '../synapse-dht/ED25519AlgorithmName';

export const hasher = new HashService([new SHA1HashAlgorithm(), new SHA256HashAlgorithm()]);

export const logger = new ConsoleLogger();
export const streamDownloader = new StreamDownloadService(logger);

const RegisterDHT = async (ioc) => {
  const superCopAlgo = await ED25519SuperCopAlgorithm.build();
  ioc.registerInstance('ISigningAlgorithm', superCopAlgo);
  ioc.registerInstance(ED25519SuperCopAlgorithm, superCopAlgo);

  return ioc;
};

(async () => {
  try {
    const seederClient = await Client.buildClient({
      extensions: [],
      registration: RegisterDHT
    });

    const signingService = new SigningService([await ED25519SuperCopAlgorithm.build(), new SECP256K1SignatureAlgorithm(hasher)]);
    const dhtService = new DHTService(await ED25519SuperCopAlgorithm.build(), hasher, logger);

    const readPath = path.join(__dirname, '..', '..', 'torrents');

    const paths = await recursiveReadDir(readPath);
    const files = CreateFilesFromPaths(paths);

    if (process.env.REGEN === 'true') {
      const { publicKey, secretKey } = await signingService.generateKeyPair(ED25519AlgorithmName);

      const serialisedKeys = { secretKey: secretKey.toString('hex'), publicKey: publicKey.toString('hex') };
      fs.writeFileSync('../../torrent_keys.ben', bencode.encode(serialisedKeys));

      const sig = await signingService.sign(Buffer.from('text'), ED25519AlgorithmName, Buffer.from(secretKey), Buffer.from(publicKey));
      logger.log('SIG', sig);

      const seederMetainfo = await seederClient.generateMetaInfo(
        files,
        'downoaded_torrents',
        (await import('@firaenix/synapse-core/src/models/SupportedHashAlgorithms')).SupportedHashAlgorithms.sha1,
        ED25519AlgorithmName,
        Buffer.from(secretKey),
        Buffer.from(publicKey)
      );
      fs.writeFileSync('../../mymetainfo.ben', bencode.encode(seederMetainfo));
    }

    const metainfobuffer = fs.readFileSync(path.join(__dirname, '..', '..', 'mymetainfo.ben'));
    const metainfoFile = bencode.decode(metainfobuffer) as SignedMetainfoFile;

    const bencodedKeys = fs.readFileSync(path.join(__dirname, '..', '..', 'torrent_keys.ben'));
    const deserialisedKeys = bencode.decode(bencodedKeys);
    const publicKeyBuffer = Buffer.from(deserialisedKeys.publicKey.toString(), 'hex');
    const secretKeyBuffer = Buffer.from(deserialisedKeys.secretKey.toString(), 'hex');
    const keyPair = new ED25519KeyPair(publicKeyBuffer, secretKeyBuffer);
    const isValid = await keyPair.isValidKeyPair();
    if (isValid === false) {
      throw new Error('Bail out, not reading keys correctly.');
    }

    if (process.env.SEEDING === 'true') {
      // const updateManager = new UpdateManager();
      // const onUpdateExtensionCreated = (ext: UpdateExtension) => {
      //   updateManager.addPeerExt(ext);
      // };

      // const seederBitcoinExtension = await GenerateBitcoinExtension('./seedkeys.ben');
      let torrentManager = await seederClient.addTorrentByMetainfo(metainfoFile, keyPair, files);
      await dhtService.publish(keyPair, metainfoFile.infosig, undefined, 0);

      logger.log('Seeding');
      let changeVersion = 0;
      chokidar.watch(readPath).on('all', async (name, filePath, stats) => {
        try {
          const changedPaths = await recursiveReadDir(readPath);
          const changedFiles = CreateFilesFromPaths(changedPaths);

          const { publicKey, secretKey } = keyPair;

          const seederMetainfo = await seederClient.generateMetaInfo(
            changedFiles,
            'downoaded_torrents',
            (await import('@firaenix/synapse-core/src/models/SupportedHashAlgorithms')).SupportedHashAlgorithms.sha1,
            ED25519AlgorithmName,
            Buffer.from(secretKey),
            Buffer.from(publicKey)
          );

          if (seederMetainfo.infohash.equals(torrentManager.metainfo.infohash)) {
            console.log('Generated same metainfo, ignore');
            return;
          }

          console.log('Path change', name, filePath, stats);

          changeVersion++;
          fs.writeFileSync(path.join(__dirname, '..', '..', `mymetainfo_${changeVersion}.ben`), bencode.encode(seederMetainfo));

          torrentManager = await seederClient.updateTorrent(torrentManager, seederMetainfo, keyPair, changedFiles);
          await dhtService.publish(keyPair, seederMetainfo.infosig, undefined, changeVersion);
        } catch (error) {
          console.error(error);
        }
      });
    }

    if (process.env.LEECHING === 'true') {
      // const leecherBitcoinExtension = await GenerateBitcoinExtension('./leechkeys.ben');
      try {
        const leecherClient = await Client.buildClient({
          extensions: [],
          registration: RegisterDHT
        });
        let torrent = await leecherClient.addTorrentByInfoSig(metainfoFile.infosig);
        streamDownloader.download(torrent, 'downloads');
        logger.log('Leeching');

        const pubKeyHash = await hasher.hash(Buffer.from(metainfoFile['pub key']), SupportedHashAlgorithms.sha1);

        dhtService.subscribe(pubKeyHash, 1000, async (data, cancel) => {
          torrent = await leecherClient.addTorrentByInfoSig(Buffer.from(data.v));
          streamDownloader.download(torrent, `downloads-${data.seq}`);
          // logger.error('Leecher got new subscription data, stopping old torrent', data);
          // await oldTorrent.stopTorrent();
        });
      } catch (error) {
        logger.fatal(error);
      }
    }
  } catch (error) {
    console.error(error);
    throw error;
  }
})();
