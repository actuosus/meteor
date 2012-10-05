(function () {

  // internal verifier collection. Never published.
  Accounts._srpChallenges = new Meteor.Collection(
    "meteor_accounts_srpChallenges", {_preventAutopublish: true});
  // Don't let people write to the collection, even in insecure
  // mode. There's no good reason for people to be fishing around in this
  // table, and it is _really_ insecure to allow it as users could easily
  // steal sessions and impersonate other users. Users can override by
  // calling more allows later, if they really want.
  Accounts._srpChallenges.allow({});

  // internal email validation tokens collection. Never published.
  Accounts._emailValidationTokens = new Meteor.Collection(
    "meteor_accounts_emailValidationTokens", {_preventAutopublish: true});
  // also lock down email validation. These can be used to log in.
  Accounts._emailValidationTokens.allow({});


  var selectorFromUserQuery = function (user) {
    if (!user)
      throw new Meteor.Error(400, "Must pass a user property in request");
    if (_.keys(user).length !== 1)
      throw new Meteor.Error(400, "User property must have exactly one field");

    var selector;
    if (user.id)
      selector = {_id: user.id};
    else if (user.username)
      selector = {username: user.username};
    else if (user.email)
      selector = {"emails.address": user.email};
    else
      throw new Meteor.Error(400, "Must pass username, email, or id in request.user");

    return selector;
  };

  Meteor.methods({
    // @param request {Object} with fields:
    //   user: either {username: (username)}, {email: (email)}, or {id: (userId)}
    //   A: hex encoded int. the client's public key for this exchange
    // @returns {Object} with fields:
    //   identiy: string uuid
    //   salt: string uuid
    //   B: hex encoded int. server's public key for this exchange
    beginPasswordExchange: function (request) {
      var selector = selectorFromUserQuery(request.user);

      var user = Meteor.users.findOne(selector);
      if (!user)
        throw new Meteor.Error(403, "User not found");

      if (!user.services || !user.services.password ||
          !user.services.password.srp)
        throw new Meteor.Error(403, "User has no password set");

      var verifier = user.services.password.srp;
      var srp = new Meteor._srp.Server(verifier);
      var challenge = srp.issueChallenge({A: request.A});

      // XXX It would be better to put this on the session
      // somehow. However, this gets complicated when interacting with
      // reconnect on the client. The client should detect the reconnect
      // and re-start the exchange.
      // https://app.asana.com/0/988582960612/1278583012594
      //
      // Instead we store M and HAMK from SRP (abstraction violation!)
      // and let any session login if it knows M. This is somewhat
      // insecure, if you don't use SSL someone can sniff your traffic
      // and then log in as you (but no more insecure than reconnect
      // tokens).
      var serialized = { userId: user._id, M: srp.M, HAMK: srp.HAMK };
      Accounts._srpChallenges.insert(serialized);

      return challenge;
    },

    changePassword: function (options) {
      if (!this.userId())
        throw new Meteor.Error(401, "Must be logged in");

      // If options.M is set, it means we went through a challenge with
      // the old password.

      if (!options.M /* could allow unsafe password changes here */) {
        throw new Meteor.Error(403, "Old password required.");
      }

      if (options.M) {
        var serialized = Accounts._srpChallenges.findOne(
          {M: options.M});
        if (!serialized)
          throw new Meteor.Error(403, "Incorrect password");
        if (serialized.userId !== this.userId())
          // No monkey business!
          throw new Meteor.Error(403, "Incorrect password");
      }

      var verifier = options.srp;
      if (!verifier && options.password) {
        verifier = Meteor._srp.generateVerifier(options.password);
      }
      if (!verifier || !verifier.identity || !verifier.salt ||
          !verifier.verifier)
        throw new Meteor.Error(400, "Invalid verifier");

      Meteor.users.update({_id: this.userId()},
                          {$set: {'services.password.srp': verifier}});

      var ret = {passwordChanged: true};
      if (serialized)
        ret.HAMK = serialized.HAMK;
      return ret;
    },

    forgotPassword: function (options) {
      var email = options.email;
       if (!email)
        throw new Meteor.Error(400, "Need to set options.email");

      var user = Meteor.users.findOne({"emails.address": email});
      if (!user)
        throw new Meteor.Error(403, "User not found");

      var token = Meteor.uuid();
      var when = +(new Date);
      Meteor.users.update(user._id, {$set: {
        "services.password.reset": {
          token: token,
          when: when
        }
      }});

      var resetPasswordUrl = Accounts.urls.resetPassword(token);
      Email.send({
        to: email,
        from: Accounts.emailTemplates.from,
        subject: Accounts.emailTemplates.resetPassword.subject(user),
        text: Accounts.emailTemplates.resetPassword.text(user, resetPasswordUrl)});
    },

    resetPassword: function (token, newVerifier) {
      if (!token)
        throw new Meteor.Error(400, "Need to pass token");
      if (!newVerifier)
        throw new Meteor.Error(400, "Need to pass newVerifier");

      var user = Meteor.users.findOne({"services.password.reset.token": token});
      if (!user)
        throw new Meteor.Error(403, "Token expired");

      Meteor.users.update({_id: user._id}, {
        $set: {'services.password.srp': newVerifier},
        $unset: {'services.password.reset': 1}
      });
      // verify their email. they got the password reset email.
      Meteor.users.update({_id: user._id},
                          {$set: {"emails.0.validated": true}});


      var loginToken = Accounts._loginTokens.insert({userId: user._id});
      this.setUserId(user._id);
      return {token: loginToken, id: user._id};
    },

    validateEmail: function (token) {
      if (!token)
        throw new Meteor.Error(400, "Need to pass token");

      var tokenDocument = Accounts._emailValidationTokens.findOne(
        {token: token});
      if (!tokenDocument)
        throw new Meteor.Error(403, "Validate email link expired");
      var userId = tokenDocument.userId;
      var email = tokenDocument.email;

      // update the validated flag on the index in the emails array
      // matching email (see
      // http://www.mongodb.org/display/DOCS/Updating/#Updating-The%24positionaloperator)
      Meteor.users.update({_id: userId, "emails.address": email},
                          {$set: {"emails.$.validated": true}});
      Accounts._emailValidationTokens.remove({token: token});

      var loginToken = Accounts._loginTokens.insert({userId: userId});
      this.setUserId(userId);
      return {token: loginToken, id: userId};
    }
  });

  // send the user an email with a link that when opened marks that
  // address as validated
  Accounts.sendValidationEmail = function (userId, email) {
    var token = Meteor.uuid();
    var when = +(new Date);
    Accounts._emailValidationTokens.insert({
      email: email,
      token: token,
      when: when,
      userId: userId
    });

    // XXX Also generate a link using which someone can delete this
    // account if they own said address but weren't those who created
    // this account.

    var user = Meteor.users.findOne(userId);
    var validateEmailUrl = Accounts.urls.validateEmail(token);
    Email.send({
      to: email,
      from: Accounts.emailTemplates.from,
      subject: Accounts.emailTemplates.validateEmail.subject(user),
      text: Accounts.emailTemplates.validateEmail.text(user, validateEmailUrl)
    });
  };

  // send the user an email informing them that their account was
  // created, with a link that when opened both marks their email as
  // validated and forces them to choose their password
  Accounts.sendEnrollmentEmail = function (userId, email) {
    var token = Meteor.uuid();
    var when = +(new Date);
    Meteor.users.update(userId, {$set: {
      "services.password.reset": {
        token: token,
        when: when
      }
    }});

    var user = Meteor.users.findOne(userId);
    var enrollAccountUrl = Accounts.urls.enrollAccount(token);
    Email.send({
      to: email,
      from: Accounts.emailTemplates.from,
      subject: Accounts.emailTemplates.enrollAccount.subject(user),
      text: Accounts.emailTemplates.enrollAccount.text(user, enrollAccountUrl)
    });
  };

  // handler to login with password
  Accounts.registerLoginHandler(function (options) {
    if (!options.srp)
      return undefined; // don't handle
    if (!options.srp.M)
      throw new Meteor.Error(400, "Must pass M in options.srp");

    var serialized = Accounts._srpChallenges.findOne(
      {M: options.srp.M});
    if (!serialized)
      throw new Meteor.Error(403, "Incorrect password");

    var userId = serialized.userId;
    var loginToken = Accounts._loginTokens.insert({userId: userId});

    // XXX we should remove srpChallenge documents from mongo, but we
    // need to make sure reconnects still work (meaning we can't
    // remove them right after they've been used). This will also be
    // fixed if we store challenges in session.
    // https://app.asana.com/0/988582960612/1278583012594

    return {token: loginToken, id: userId, HAMK: serialized.HAMK};
  });

  // handler to login with plaintext password.
  //
  // The meteor client doesn't use this, it is for other DDP clients who
  // haven't implemented SRP. Since it sends the password in plaintext
  // over the wire, it should only be run over SSL!
  //
  // Also, it might be nice if servers could turn this off. Or maybe it
  // should be opt-in, not opt-out? Accounts.config option?
  Accounts.registerLoginHandler(function (options) {
    if (!options.password || !options.user)
      return undefined; // don't handle

    var selector = selectorFromUserQuery(options.user);
    var user = Meteor.users.findOne(selector);
    if (!user)
      throw new Meteor.Error(403, "User not found");

    if (!user.services || !user.services.password ||
        !user.services.password.srp)
      throw new Meteor.Error(403, "User has no password set");

    // Just check the verifier output when the same identity and salt
    // are passed. Don't bother with a full exchange.
    var verifier = user.services.password.srp;
    var newVerifier = Meteor._srp.generateVerifier(options.password, {
      identity: verifier.identity, salt: verifier.salt});

    if (verifier.verifier !== newVerifier.verifier)
      throw new Meteor.Error(403, "Incorrect password");

    var loginToken = Accounts._loginTokens.insert({userId: user._id});
    return {token: loginToken, id: user._id};
  });


  Meteor.setPassword = function (userId, newPassword) {
    var user = Meteor.users.findOne(userId);
    if (!user)
      throw new Meteor.Error(403, "User not found");
    var newVerifier = Meteor._srp.generateVerifier(newPassword);

    Meteor.users.update({_id: user._id}, {
      $set: {'services.password.srp': newVerifier}});
  };


  ////////////
  // Creating users:


  // Shared createUser function called from the createUser method, both
  // if originates in client or server code. Calls user provided hooks,
  // does the actual user insertion.
  //
  // returns userId or throws an error if it can't create
  var createUser = function (options, extra) {
    extra = extra || {};
    var username = options.username;
    var email = options.email;
    if (!username && !email)
      throw new Meteor.Error(400, "Need to set a username or email");

    if (username && Meteor.users.findOne({username: username}))
      throw new Meteor.Error(403, "User already exists with username " + username);
    if (email && Meteor.users.findOne({"emails.address": email})) {
      throw new Meteor.Error(403, "User already exists with email " + email);
    }

    // Raw password. The meteor client doesn't send this, but a DDP
    // client that didn't implement SRP could send this. This should
    // only be done over SSL.
    if (options.password) {
      if (options.srp)
        throw new Meteor.Error(400, "Don't pass both password and srp in options");
      options.srp = Meteor._srp.generateVerifier(options.password);
    }

    var user = {services: {}};
    if (options.srp)
      user.services.password = {srp: options.srp}; // XXX validate verifier
    if (username)
      user.username = username;
    if (email)
      user.emails = [{address: email, validated: false}];

    user = Accounts.onCreateUserHook(options, extra, user);
    var userId = Meteor.users.insert(user);
    return userId;
  };

  // method for create user. Requests come from the client.
  Meteor.methods({
    createUser: function (options, extra) {
      if (Accounts._options.forbidSignups)
        throw new Meteor.Error(403, "Signups forbidden");

      var userId = createUser(options, extra);
      // safety belt. createUser is supposed to throw on error. send 500
      // error instead of creating a login token with empty userid.
      if (!userId)
        throw new Error("createUser failed to insert new user");

      // If `Accounts._options.validateEmails` is set, register
      // a token to validate the user's primary email, and send it to
      // that address.
      if (options.email && Accounts._options.validateEmails)
        Accounts.sendValidationEmail(userId, options.email);

      // client gets logged in as the new user afterwards.
      var loginToken = Accounts._loginTokens.insert({userId: userId});
      this.setUserId(userId);
      return {token: loginToken, id: userId};
    }
  });

  // Create user directly on the server.
  //
  // Unlike the client version, this does not log you in as this user
  // after creation.
  //
  // returns userId or throws an error if it can't create
  Accounts.createUser = function (options, extra, callback) {

    if (typeof extra === "function") {
      callback = extra;
      extra = {};
    }

    // XXX allow an optional callback?
    if (callback) {
      throw new Error("Meteor.createUser with callback not supported on the server yet.");
    }

    var userId = createUser(options, extra);

    // send email if the user has an email and no password
    var user = Meteor.users.findOne(userId);
    if (
        // user has email address
      (user && user.emails && user.emails.length &&
       user.emails[0].address) &&
        // and does not have a password
      !(user.services && user.services.password &&
        user.services.password.srp)) {

      var email = user.emails[0].address;
      Accounts.sendEnrollmentEmail(userId, email);
    }

    return userId;
  };




})();
