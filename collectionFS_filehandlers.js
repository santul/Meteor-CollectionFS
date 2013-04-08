//Server cache worker, idear:
//
//Basics
//On server load init worker and taskQue if needed by collection if (fileHandlers)
//When client confirms uploads run user defined functions on file described in fileHandlers
//if null returned then proceed to the next function in fileHandler array
//if data returned then put it in a file in eg.:  uploads/cfs/collection._name folder and update url array reference in database, triggers reactive update UI
//Note: updating files in uploads refreshes server? - find solution later, maybe patch meteor core?
//
//In model:
//CollectionFS.fileHandlers({
//  //Default image cache
//  handler['default']: function(fileId, blob) {
//    return blob;
//  },
//  //Some specific
//  handler['40x40']: function(fileId, blob) {
//     //Some serverside image/file handling functions, user can define this
//     return blob;
//   },
//  //Upload to remote server
//  handler['remote']: function(fileId, blob) {
//     //Some serverside imagick/file handling functions, user can define this
//     return null;
//   },
//   
// });
//
// Server:
// on startup queueListener spawned if needed by collectionFS - one queueListener pr collectionFS
// queueListener spawns fileHandlers pr. item in fileHandlerQue as setTimeout(, 0) and delete item from queue
// if empty queue then die and wait, spawn by interval
// server sets .handledAt = Date.now(), .fileHandler[]
// fileHandlers die after ended
// Filehandlers respect __filehandlers.MaxRunning on server, set to 1 pr. default for throttling the server.
// 
// Client:
// When upload confirmed complete, set fs.files.complete and add _id to collectionFS.fileHandlerQue (wich triggers a worker at interval)
// 

//var queueListener = new _queueListener();

var fs = Npm.require('fs');
var path = Npm.require('path');


 _queueListener = function(collectionFS) {
	var self = this;
	self.collectionFS = collectionFS;

    // Init directory for collection
	self.serverPath = path.join(__filehandlers.serverPath, self.collectionFS._name);  // Server path
	self.pathURL = __filehandlers.url + '/' + self.collectionFS._name;   // Url path

	if (!fs.existsSync(self.serverPath))
		fs.mkdirSync(self.serverPath);

	self.pathCreated = (!!fs.existsSync(self.serverPath));		

	//Spawn worker:
	Meteor.setTimeout(function() { self.checkQueue(); }, 0); //Initiate worker process

};//EO queueListener

_.extend(_queueListener.prototype, {
	checkQueue: function() {
		var self = this;
		//check items in queue and init workers for conversion
		if (self.collectionFS) {
			if (self.collectionFS._fileHandlers) {
				//ok got filehandler object, spawn worker?
				if (__filehandlers.Running < __filehandlers.MaxRunning) {
					__filehandlers.Running++;

					// First, Try to find new unhandled files					
					var fileRecord = self.collectionFS.findOne({ handledAt: null, complete: true }); //test sumChunk == countChunks in mongo?

					// Second, Try to find new filehandlers, not yet applied
					if (!fileRecord) {
						// Create a query array from filehandlers
						var queryFilehandlersExists = [];
						for (var func in self.collectionFS._fileHandlers) {
							var queryExists = {};
							queryExists['fileHandler.'+func] = { $exists: false };
							queryFilehandlersExists.push(queryExists);
						}

						//	Where one of the fileHandlers are missing
						fileRecord = self.collectionFS.findOne({ complete: true, 
																 $or: queryFilehandlersExists, 
																 'fileHandler.error': { $exists: false } });
					} // EO Try to find new filehandlers

					// Last, Try to find failed filehanders
					if (!fileRecord) {
						// Create a query array from filehandlers
						var queryFilehandlersFailed = [];
						for (var func in self.collectionFS._fileHandlers) {
							var queryFailed = {};
							queryFailed['fileHandler.' + func + '.failed'] = { $exists: true, 
																			   $lt: __filehandlers.MaxFailes, 
																			   'fileHandler.error': { $exists: false } };
							queryFilehandlersFailed.push(queryFailed);
						}

						//	Where the fileHandler contains an element with a failed set less than __filehandlers.MaxFailes
						fileRecord = self.collectionFS.findOne({ complete: true, 
																 $or: queryFilehandlersFailed });
					}

					// Handle file, spawn worker
					if (fileRecord) {					
						self.workFileHandlers(fileRecord, self.collectionFS._fileHandlers);
						__filehandlers._AllowFailesRetryLastTime = Date.now();
					} else {
						// We shouldn't get bored, are we going to retry failed filehandlers or sleep a bit or eight?
						if (__filehandlers.AllowFailesRetry ) {
							var waitedEnough = ((__filehandlers._AllowFailesRetryLastTime+__filehandlers.AllowFailesRetry) < Date.now());
							// We wait a period before retrying
							if ( waitedEnough )
								for (var func in self.collectionFS._fileHandlers) {
									// reset failed to 1 on all failed filehandlers, triggering a restart of failed retry
									var queryFailed = {};
									var querySetFailed = {};
									queryFailed['fileHandler.' + func + '.failed'] = { $exists: true };
									querySetFailed['fileHandler.' + func + '.failed'] = 1;
									// We do reset pr. filehandler
									self.collectionFS.update(queryFailed, { $set: querySetFailed });
								}
						} // EO restart handling failed handlers?
					} // EO No fileRecord found

					__filehandlers.Running--;
				} // EO Filehandler

				if (__filehandlers.waitBeforeCheckingQueue)
					Meteor.setTimeout(function() { self.checkQueue(); }, __filehandlers.waitBeforeCheckingQueue); //Wait a second 1000	
			} else {
				if (__filehandlers.waitBeforeCheckingQueueWhenNoFilehandlers)
					Meteor.setTimeout(function() { self.checkQueue(); }, __filehandlers.waitBeforeCheckingQueueWhenNoFilehandlers); //Wait 5 second 5000	
			}
		} //No collection?? cant go on..
	}, //EO checkQueue

	workFileHandlers: function(fileRecord, fileHandlers) {
		var self = this;
		//Retrive blob
		var fileSize = +fileRecord['length']; //+ Due to Meteor issue
		//Allocate mem
		var blob = new Buffer(fileSize);
		//var blob = new Buffer(fileRecord['length'], { type: fileRecord.contentType}); //Allocate mem
		var query = self.collectionFS.chunks.find({ files_id: fileRecord._id}, { sort: {n: 1} }); // Deleted $sort

		if (query.count() == 0) {
			// TODO: Implement serverside fetch remote file
			// This could be triggered if client requests server to go fetch to file...
			// We should check if remoteUrl isset
			// Check if we should set headers for retrieving file? eg. login
			// Maybe introduce "remoteFilehandlers" for fetching remote files?
			
			if (fileRecord.remoteUrl) {
				//     goFetchRemoteFileToDatabase - use the server side storeFile
				throw new Error('Serverside file fetching not implemented');
				return;
			} else {
				// A completed file with no chunks or a remoteUrl set is corrupted, remove
				if ( fileRecord.complete && fileRecord._id )
					self.collectionFS.remove({ _id: fileRecord._id });
				return;
			}

		} // EO No chunks in file

		query.rewind();
		
		// Create the file blob for the filehandlers to use
		query.forEach(function(chunk){
			if (! chunk.data) {
				// Somethings wrong, we'll throw an error
				throw new Error('Filehandlers for file id: ' + fileRecord._id + ' got empty data chunk.n:' + chunk.n);
			}
			// Finally do the data appending
			for (var i = 0; i < chunk.data.length; i++) {
				blob[(chunk.n * fileRecord.chunkSize) + i] = chunk.data.charCodeAt(i);
				//blob.writeUInt8( ((chunk.n * fileRecord.chunkSize) + i), chunk.data.charCodeAt(i) );
			}
		}); //EO find chunks

		//do some work, execute user defined functions
		for (var func in fileHandlers) {

			// Is filehandler allready found?
			var filehandlerFound = (fileRecord.fileHandler && fileRecord.fileHandler[func]);

			// Set sum of filehandler failures - if not found the default to 0
			var sumFailes = (filehandlerFound && fileRecord.fileHandler[func].failed)?
							fileRecord.fileHandler[func].failed : 0;
			// if not filehandler or filehandler found in fileRecord.fileHandlers then check if failed
			if (! filehandlerFound || ( sumFailes && sumFailes < __filehandlers.MaxFailes) ) {

				// destination - a helper for the filehandlers
				// [newExtension] is optional and with/without a leading '.'
				// Returns
				// 		serverFilename - where the filehandler can write the file if wanted
				// 		fileData - contains future url reference and extension for the database
				// 		
				var destination = function(newExtension) {
					// Make newExtension optional, fallback to fileRecord.filename
					var extension = (newExtension)? newExtension : path.extname(fileRecord.filename);
					// Remove optional leading '.' from extension name
					extension = (extension.substr(0, 1) == '.')? extension.substr(1) : extension;
					// Construct filename from '_id' filehandler name and extension
					var myFilename = fileRecord._id + '_' + func + '.' + extension;
					// Construct url TODO: Should URL encode (could cause trouble in the remove observer)
					var myUrl = self.pathURL + '/' + myFilename;

					return { 
						serverFilename: path.join(self.serverPath, myFilename), 
						fileData: { 
							url: myUrl,							 
							extension: extension.toLowerCase()
						} 
					};
				}; // EO destination

				// We normalize filehandler data preparing it for the database
				// func is the filehandler eg. "resize256"
				// fileData is the data to return from the file handler, eg. url and extension
				var normalizeFilehandle = function(func, fileData) {
					var myData = {};
					myData['fileHandler.'+func] = (fileData)?fileData:{};
					myData['fileHandler.'+func].createdAt = Date.now();
					return myData;
				};

				var result = false;
				try {
					result = fileHandlers[func]({ fileRecord: fileRecord, blob: blob, destination: destination, sumFailes: sumFailes });
				} catch(e) {
					throw new Error('Error in filehandler: "' + func + '" ' + (e.trace || e.message));
				}

				if (result) { //A result means do something for user defined function...
					//Save on filesystem
					if (result.blob) {
						//save the file and update fileHandler
	
						fs.writeFileSync(destination(result.extension).serverFilename, result.blob, 'binary')
						//Add to fileHandler array
						if (fs.existsSync(destination(result.extension).serverFilename)) {
							self.collectionFS.files.update({ _id: fileRecord._id }, { 
								$set: normalizeFilehandle(func, destination(result.extension).fileData)
							}); //EO Update
						} else {
							// File could not be written to filesystem? Don't try this filehandler again
							self.collectionFS.files.update({ _id: fileRecord._id }, {
								$set: normalizeFilehandle(func, { error: 'Filehandler could not write to filesystem' })
							}); //EO Update

							throw new Error('Filehandler "' + func + '" could not write to filesystem');
						}

					} else {

						//no blob? Just save result as filehandler data
						self.collectionFS.files.update({ _id: fileRecord._id }, {
							$set: normalizeFilehandle(func, result)
						}); //EO Update

					} //EO no blob
				} else {  //Otherwise guess filehandler wants something else?
					if (result === null) {

						//if null returned then ok, dont run again - we update the db
						self.collectionFS.files.update({ _id: fileRecord._id }, {
							$set: normalizeFilehandle(func)
						}); //EO Update

					} else { // But if false then we got an error - handled by the queue		

						// Do nothing, try again sometime later defined by config policy
						self.collectionFS.files.update({ _id: fileRecord._id }, {
							$set: normalizeFilehandle(func, { failed: (sumFailes+1) })
						}); //EO Update
				
					}//EO filehandling failed
				} //EO no result

			} // EO if allready found or max failures reached
		} //EO Loop through fileHandler functions

        //Update fileHandler in db
        self.collectionFS.files.update({ _id: fileRecord._id }, { $set: { handledAt: Date.now() } });
	} //EO workFileHandlers

});//EO queueListener extend

